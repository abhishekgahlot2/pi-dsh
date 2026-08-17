// Append-only interrupted-run repair over Pi's native entries and records.

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { buildSessionContext, type ContextEntryTransform, type SessionContext } from "../vendor/pi/harness/session/context.ts";
import type {
	Entry,
	LaneRecord,
	MessageEntry,
	NewRecord,
	OperationFinishedRecord,
	OperationStartedRecord,
	SessionStorage,
	ToolStartedRecord,
} from "../vendor/pi/harness/session/types.ts";
import { SessionError } from "../vendor/pi/harness/session/types.ts";

export const TOOL_OUTCOME_UNKNOWN_TEXT =
	"The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.";

export const TOOL_NOT_STARTED_TEXT =
	"The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.";

const TOOL_REPLAY_SAFE_TEXT = " This tool is classified replay-safe, so it can be retried if still needed.";

export interface RepairSessionStore
	extends Pick<
		SessionStorage,
		"appendEntry" | "findEntriesOnBranch" | "findOpenOperations" | "findRecords" | "getEntry" | "getLanes"
	> {
	appendRecord(record: NewRecord): Promise<LaneRecord>;
}

export interface RepairResult {
	runId: string | null;
	appendedEntries: number;
	appendedRecords: number;
}

type ToolCallBlock = Extract<MessageEntry["message"], { role: "assistant" }>["content"][number] & {
	type: "toolCall";
};

interface PendingToolCall {
	assistantEntry: MessageEntry;
	toolCall: ToolCallBlock;
	toolIndex: number;
}

/**
	 * Repair is append-only over Pi v4 entries and records, and closes exactly one
	 * open main-lane operation.
 */
export async function repairInterruptedOperation(store: RepairSessionStore): Promise<RepairResult> {
	const openOperations = await store.findOpenOperations("main", { limit: 2 });
	if (openOperations.length === 0) {
		return { runId: null, appendedEntries: 0, appendedRecords: 0 };
	}
	if (openOperations.length > 1) {
		throw new SessionError("storage", "Session has more than one open operation on main");
	}

	const operation = openOperations[0]!;
	const branchEntries = await entriesInOpenOperation(store, operation);
	const runRecords = await store.findRecords({
		lane: "main",
		runId: operation.id,
		afterSeq: operation.seq,
		order: "oldestFirst",
	});
	const toolStartedByCallId = new Map(
		runRecords
			.filter((record): record is ToolStartedRecord => record.type === "tool_started")
			.map((record) => [record.toolCallId, record]),
	);
	const durableToolResultCallIds = new Set(
		branchEntries
			.filter(isToolResultEntry)
			.map((entry) => entry.message.toolCallId),
	);

	let appendedEntries = 0;
	for (const pending of pendingToolCalls(branchEntries)) {
		const started = toolStartedByCallId.get(pending.toolCall.id);
		if (durableToolResultCallIds.has(pending.toolCall.id)) continue;
		if (started !== undefined && (await durableToolResultExists(store, started))) continue;

		const resultEntry = createSyntheticToolResultEntry(pending, started);
		await store.appendEntry<MessageEntry>(resultEntry, "main");
		appendedEntries += 1;
	}

	await store.appendRecord(createInterruptedOperationFinished(operation));
	return { runId: operation.id, appendedEntries, appendedRecords: 1 };
}

async function entriesInOpenOperation(
	store: RepairSessionStore,
	operation: OperationStartedRecord,
): Promise<MessageEntry[]> {
	const leafId = (await store.getLanes()).find((lane) => lane.lane === "main")?.leafId;
	if (leafId === undefined) throw new SessionError("invalid_lane", "Lane not found: main");
	if (leafId === null) return [];

	const entries = await store.findEntriesOnBranch({
		start: leafId,
		order: "oldestFirst",
		...(operation.sourceLeafId === null ? {} : { stopAtId: operation.sourceLeafId }),
	});
	return entries.filter(
		(entry): entry is MessageEntry =>
			entry.type === "message" && entry.id !== operation.sourceLeafId && entry.seq > operation.seq,
	);
}

function pendingToolCalls(entries: readonly MessageEntry[]): PendingToolCall[] {
	const pending: PendingToolCall[] = [];
	for (const entry of entries) {
		if (entry.message.role !== "assistant") continue;
		entry.message.content.forEach((content, index) => {
			if (content.type !== "toolCall") return;
			pending.push({ assistantEntry: entry, toolCall: content, toolIndex: index });
		});
	}
	return pending;
}

async function durableToolResultExists(store: RepairSessionStore, record: ToolStartedRecord): Promise<boolean> {
	const resultEntry = await store.getEntry(record.resultEntryId);
	return resultEntry !== undefined && isToolResultEntry(resultEntry);
}

function isToolResultEntry(entry: Entry): entry is MessageEntry & { message: ToolResultMessage } {
	return entry.type === "message" && entry.message.role === "toolResult";
}

function createSyntheticToolResultEntry(
	pending: PendingToolCall,
	started: ToolStartedRecord | undefined,
): Omit<MessageEntry, "parentId" | "seq" | "timestamp"> {
	const toolCallId = pending.toolCall.id;
	const contentText =
		started === undefined
			? TOOL_NOT_STARTED_TEXT
			: `${TOOL_OUTCOME_UNKNOWN_TEXT}${started.replay === "safe" ? TOOL_REPLAY_SAFE_TEXT : ""}`;
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: pending.toolCall.name,
		content: [{ type: "text", text: contentText }],
		details: {},
		isError: true,
		timestamp: pending.assistantEntry.timestamp,
	};
	return {
		type: "message",
		id: started?.resultEntryId ?? `interrupted-tool-result-${toolCallId}-${pending.assistantEntry.seq}`,
		message,
	};
}

function createInterruptedOperationFinished(
	operation: OperationStartedRecord,
): NewRecord<OperationFinishedRecord> {
	return {
		type: "operation_finished",
		id: `interrupted-operation-finished-${operation.id}`,
		lane: operation.lane,
		runId: operation.id,
		outcome: "aborted",
		error: {
			code: "INTERRUPTED",
			message: "operation interrupted by crash; repaired on open",
		},
	};
}

export const skipTrailingAbortedAssistantEntries: ContextEntryTransform = (entries: readonly Entry[]) => {
	const retained = [...entries];
	while (true) {
		const tail = retained.at(-1);
		if (
			tail?.type === "message" &&
			tail.message.role === "assistant" &&
			(tail.message.stopReason === "aborted" || tail.message.stopReason === "error")
		) {
			retained.pop();
			continue;
		}
		return retained;
	}
};

export function buildRepairSafeSessionContext(entries: readonly Entry[]): SessionContext {
	return buildSessionContext(entries, { entryTransforms: [skipTrailingAbortedAssistantEntries] });
}
