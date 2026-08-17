// Closed-prefix transactions preserve tool balance, provenance, and surface stability.

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../vendor/pi/types.ts";
import { buildSessionContext } from "../vendor/pi/harness/session/context.ts";
import type {
	CompactionEntry,
	CompactionReason,
	Entry,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	SessionStorage,
	StepAttemptRecord,
} from "../vendor/pi/harness/session/types.ts";

export interface CompactionPolicy {
	enabled?: boolean;
	thresholdRatio?: number;
	contextWindow: number;
	retainedTailTokens: number;
	maxOverflowRetries?: number;
}

export interface CompactionDetails {
	shadowedEntryIds: string[];
	shadowedTokenCount: number;
	cutEntryId: string;
	retainedEntryIds: string[];
}

export interface CompactionResult {
	compaction: CompactionEntry;
	operationId: string;
	stepId: string;
}

export interface CompactionSummarizer {
	summarize(input: {
		shadowedEntries: readonly Entry[];
		shadowedMessages: readonly AgentMessage[];
		retainedTail: readonly AgentMessage[];
		reason: CompactionReason;
	}): Promise<{ summary: string; usage?: Usage }>;
}

export interface CompactionStore
	extends Pick<
		SessionStorage,
		"getLanes" | "getEntry" | "findEntriesOnBranch" | "findOpenOperations" | "findRecords" | "appendRecord" | "appendEntry"
	> {
	runExclusive?<T>(job: () => Promise<T>): Promise<T>;
}

export class SurfaceChangedError extends Error {
	constructor() {
		super("Compaction surface changed before commit");
		this.name = "SurfaceChangedError";
	}
}

export class CompactionRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompactionRejectedError";
	}
}

export function shouldCompactAtStep(contextTokens: number, policy: CompactionPolicy): boolean {
	if (policy.enabled === false) return false;
	return contextTokens >= policy.contextWindow * (policy.thresholdRatio ?? 0.8);
}

export function estimateMessageTokens(message: AgentMessage): number {
	return Math.ceil(JSON.stringify(message).length / 4);
}

export function estimateEntriesTokens(entries: readonly Entry[]): number {
	return estimateMessagesTokens(buildSessionContext(entries).messages);
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function entryMessages(entry: Entry): AgentMessage[] {
	return buildSessionContext([entry]).messages;
}

function hasToolCalls(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		message.content.some((block) => typeof block === "object" && block !== null && block.type === "toolCall")
	);
}

function toolResultCallIds(message: AgentMessage): string[] {
	if (message.role !== "toolResult") return [];
	const callId = (message as { toolCallId?: unknown }).toolCallId;
	return typeof callId === "string" ? [callId] : [];
}

function assistantToolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant") return [];
	return message.content.flatMap((block) => {
		if (typeof block !== "object" || block === null || block.type !== "toolCall") return [];
		const id = (block as { id?: unknown; toolCallId?: unknown }).id ?? (block as { id?: unknown; toolCallId?: unknown }).toolCallId;
		return typeof id === "string" ? [id] : [];
	});
}

function isBalanced(entries: readonly Entry[]): boolean {
	const pending = new Set<string>();
	for (const entry of entries) {
		for (const message of entryMessages(entry)) {
			for (const id of assistantToolCallIds(message)) pending.add(id);
			for (const id of toolResultCallIds(message)) pending.delete(id);
		}
	}
	return pending.size === 0;
}

export function selectClosedPrefix(
	pathEntries: readonly Entry[],
	retainedTailTokens: number,
	explicitCutEntryId?: string,
): { shadowedEntries: Entry[]; retainedEntries: Entry[] } {
	if (pathEntries.length < 2) throw new CompactionRejectedError("Compaction needs at least two entries");

	let cutIndex: number;
	if (explicitCutEntryId !== undefined) {
		cutIndex = pathEntries.findIndex((entry) => entry.id === explicitCutEntryId);
		if (cutIndex <= 0) throw new CompactionRejectedError(`Invalid compaction cut entry: ${explicitCutEntryId}`);
		const shadowedEntries = pathEntries.slice(0, cutIndex);
		if (!isBalanced(shadowedEntries)) throw new CompactionRejectedError("Explicit compaction cut splits a tool call pair");
		return { shadowedEntries, retainedEntries: pathEntries.slice(cutIndex) };
	}
	if (retainedTailTokens === 0) {
		cutIndex = pathEntries.length;
		while (cutIndex > 0 && !isBalanced(pathEntries.slice(0, cutIndex))) cutIndex--;
		if (cutIndex <= 0) throw new CompactionRejectedError("No balanced closed prefix is available for compaction");
		return { shadowedEntries: pathEntries.slice(0, cutIndex), retainedEntries: pathEntries.slice(cutIndex) };
	}

	let retainedTokens = 0;
	cutIndex = pathEntries.length - 1;
	for (; cutIndex > 0; cutIndex--) {
		retainedTokens += estimateEntriesTokens([pathEntries[cutIndex]!]);
		if (retainedTokens >= retainedTailTokens) break;
	}

	while (cutIndex > 0 && !isBalanced(pathEntries.slice(0, cutIndex))) cutIndex--;
	while (cutIndex > 0 && pathEntries[cutIndex - 1] !== undefined) {
		const messages = entryMessages(pathEntries[cutIndex - 1]!);
		if (!messages.some(hasToolCalls)) break;
		if (isBalanced(pathEntries.slice(0, cutIndex))) break;
		cutIndex--;
	}
	if (cutIndex <= 0) throw new CompactionRejectedError("No balanced closed prefix is available for compaction");
	return { shadowedEntries: pathEntries.slice(0, cutIndex), retainedEntries: pathEntries.slice(cutIndex) };
}

function sameEntryIds(left: readonly Entry[], right: readonly Entry[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry.id === right[index]?.id && entry.seq === right[index]?.seq);
}

function messagesFor(entries: readonly Entry[]): AgentMessage[] {
	return entries.flatMap(entryMessages);
}

function nextId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function latestMainLeaf(store: Pick<SessionStorage, "getLanes">): Promise<string | null> {
	return (await store.getLanes()).find((lane) => lane.lane === "main")?.leafId ?? null;
}

async function assertNoOpenCompaction(store: CompactionStore): Promise<void> {
	const openCompactions = (await store.findOpenOperations("main")).filter((operation) => operation.intent.kind === "compaction");
	if (openCompactions.length > 0) throw new CompactionRejectedError("A compaction operation is already open");
	const openRuns = (await store.findOpenOperations("main")).filter((operation) => operation.intent.kind === "run");
	for (const run of openRuns) {
		const records = await store.findRecords({ lane: "main", runId: run.id, order: "newestFirst", limit: 1 });
		const latest = records[0];
		if (
			latest?.type === "step_attempt" &&
			latest.step === "compaction" &&
			(await store.getEntry(latest.resultEntryId)) === undefined
		) {
			throw new CompactionRejectedError("A compaction step is already open");
		}
	}
}

async function appendFailure(store: CompactionStore, operationId: string, message: string): Promise<void> {
	try {
		await store.appendRecord<OperationFinishedRecord>({
			type: "operation_finished",
			id: nextId("compaction-failed"),
			lane: "main",
			runId: operationId,
			outcome: "failed",
			error: { code: "compaction_failed", message },
		});
	} catch {
		// C6: close exactly once on the live failure path; if that fails, repair must see the open bracket.
	}
}

export async function compactClosedPrefix(
	store: CompactionStore,
	summarizer: CompactionSummarizer,
	options: { policy: CompactionPolicy; reason?: CompactionReason; explicitCutEntryId?: string; runId?: string },
): Promise<CompactionResult | undefined> {
	const reason = options.reason ?? "threshold";
	const leafId = await latestMainLeaf(store);
	if (leafId === null) return undefined;
	const beforeEntries = await store.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
	const tokensBefore = estimateEntriesTokens(beforeEntries);
	if (reason === "threshold" && !shouldCompactAtStep(tokensBefore, options.policy)) return undefined;

	const retainedTailTokens = reason === "overflow" ? 0 : options.policy.retainedTailTokens;
	const selection = selectClosedPrefix(beforeEntries, retainedTailTokens, options.explicitCutEntryId);
	const resultEntryId = nextId("compaction");
	await assertNoOpenCompaction(store);

	const operationId = options.runId ?? nextId("operation");
	if (options.runId === undefined) {
		await store.appendRecord<OperationStartedRecord>({
			type: "operation_started",
			id: operationId,
			lane: "main",
			sourceLeafId: leafId,
			intent: { kind: "compaction", resultEntryId },
		});
	} else {
		const [openRun] = await store.findOpenOperations("main", { limit: 1 });
		if (openRun?.id !== options.runId || openRun.intent.kind !== "run") {
			throw new CompactionRejectedError(`Run is not open: ${options.runId}`);
		}
	}
	const stepId = nextId("step");
	await store.appendRecord<StepAttemptRecord>({
		type: "step_attempt",
		id: stepId,
		lane: "main",
		runId: operationId,
		step: "compaction",
		attempt: 1,
		resultEntryId,
		compactionReason: reason,
	});

	try {
		const retainedTail = messagesFor(selection.retainedEntries);
		const shadowedMessages = messagesFor(selection.shadowedEntries);
		const summaryResult = await summarizer.summarize({
			shadowedEntries: selection.shadowedEntries,
			shadowedMessages,
			retainedTail,
			reason,
		});
		const shadowedTokenCount = estimateEntriesTokens(selection.shadowedEntries);
		const framedSummaryTokens = estimateMessagesTokens([
			{ role: "compactionSummary", summary: summaryResult.summary, tokensBefore, timestamp: 0 },
		]);
		if (framedSummaryTokens >= shadowedTokenCount) {
			throw new CompactionRejectedError("Compaction summary does not shrink the selected prefix");
		}

		const commit = async (): Promise<CompactionResult> => {
			const latestLeaf = await latestMainLeaf(store);
			if (latestLeaf !== leafId) throw new SurfaceChangedError();
			const currentEntries = await store.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
			const currentSelection = selectClosedPrefix(currentEntries, retainedTailTokens, options.explicitCutEntryId);
			if (
				!sameEntryIds(currentSelection.shadowedEntries, selection.shadowedEntries) ||
				!sameEntryIds(currentSelection.retainedEntries, selection.retainedEntries)
			) {
				throw new SurfaceChangedError();
			}
			const compaction = await store.appendEntry<CompactionEntry>(
				{
					type: "compaction",
					id: resultEntryId,
					summary: summaryResult.summary,
					retainedTail,
					tokensBefore,
					details: {
						shadowedEntryIds: selection.shadowedEntries.map((entry) => entry.id),
						shadowedTokenCount,
						cutEntryId: selection.retainedEntries[0]?.id ?? selection.shadowedEntries.at(-1)!.id,
						retainedEntryIds: selection.retainedEntries.map((entry) => entry.id),
					} satisfies CompactionDetails,
					...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage }),
				} satisfies ProvisionedEntry<CompactionEntry>,
				"main",
			);
			if (options.runId === undefined) {
				await store.appendRecord<OperationFinishedRecord>({
					type: "operation_finished",
					id: nextId("compaction-completed"),
					lane: "main",
					runId: operationId,
					outcome: "completed",
				});
			}
			return { compaction, operationId, stepId };
		};

		return store.runExclusive ? await store.runExclusive(commit) : await commit();
	} catch (error) {
		if (options.runId === undefined) {
			await appendFailure(store, operationId, error instanceof Error ? error.message : String(error));
		}
		throw error;
	}
}

export function isContextOverflowError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /context|token|too large|maximum/i.test(error.message) && /overflow|length|limit|exceed|too large/i.test(error.message);
}

export class OverflowRetryGate {
	private retries = 0;

	constructor(private readonly maxRetries: number) {}

	canRetry(previousCompactionEntryId: string | undefined, nextCompactionEntryId: string | undefined): boolean {
		if (previousCompactionEntryId === nextCompactionEntryId) return false;
		if (nextCompactionEntryId === undefined) return false;
		if (this.retries >= this.maxRetries) return false;
		this.retries += 1;
		return true;
	}

	resetAfterAssistantSuccess(): void {
		this.retries = 0;
	}
}
