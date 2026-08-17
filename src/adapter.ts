// Pi-loop adaptation enforces durable pre-tool dispatch and repair-safe resume;
// request projection keeps durable constraints in every provider request.

import {
	uuidv7,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

import { runAgentLoop, runAgentLoopContinue, type AgentEventSink } from "../vendor/pi/agent-loop.ts";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	StreamFn,
} from "../vendor/pi/types.ts";
import type {
	Entry,
	LaneRecord,
	MessageEntry,
	NewRecord,
	OperationFinishedRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueEnqueuedRecord,
	SessionStopReason,
	SessionStorage,
	ToolStartedRecord,
} from "../vendor/pi/harness/session/types.ts";
import { buildRepairSafeSessionContext } from "./repair.ts";
import { foldConstraints } from "./constraints.ts";
import {
	effectiveRequestSnapshot,
	REQUEST_HEADER_TYPE,
	stripUndefinedJson,
	type PromptContribution,
} from "./request-snapshot.ts";

export { REQUEST_HEADER_TYPE } from "./request-snapshot.ts";

export interface AdapterSessionStore
	extends Pick<
		SessionStorage,
		"appendEntry" | "findEntriesOnBranch" | "getLanes" | "getMetadata"
	> {
	appendRecord(record: NewRecord): Promise<LaneRecord>;
}

export interface PiDshAdapterOptions {
	store: AdapterSessionStore;
	context: AgentContext;
	config: AgentLoopConfig;
	streamFn: StreamFn;
	idGenerator?: () => string;
	getRuntimeContributions?: () => RuntimeContributionSnapshot | Promise<RuntimeContributionSnapshot>;
	replayForTool?: (context: BeforeToolCallContext) => ToolStartedRecord["replay"];
	onEvent?: AgentEventSink;
	onLoopResult?: (context: {
		runId: string;
		messages: AgentMessage[];
		continueRun: () => Promise<AgentMessage[]>;
	}) => Promise<AgentMessage[]>;
	onOperationFinished?: (context: OperationFinishedHookContext) => void | Promise<void>;
}

export interface RunPromptOptions {
	prompts: AgentMessage[];
	signal?: AbortSignal;
}

export interface ContinueOptions {
	signal?: AbortSignal;
}

export interface RuntimeContributionSnapshot {
	tools?: AgentTool[];
	promptContributors?: PromptContribution[];
}

export interface OperationFinishedHookContext {
	runId: string;
	outcome: OperationFinishedRecord["outcome"];
	error?: OperationFinishedRecord["error"];
}

interface PreparedMessageEntry {
	id: string;
	entry: ProvisionedEntry<MessageEntry>;
}

export class PiDshLoopAdapter {
	private readonly store: AdapterSessionStore;
	private readonly baseContext: AgentContext;
	private readonly baseConfig: AgentLoopConfig;
	private readonly streamFn: StreamFn;
	private readonly nextId: () => string;
	private readonly getRuntimeContributions: () => RuntimeContributionSnapshot | Promise<RuntimeContributionSnapshot>;
	private readonly replayForTool: (context: BeforeToolCallContext) => ToolStartedRecord["replay"];
	private readonly onEvent: AgentEventSink;
	private readonly onLoopResult: PiDshAdapterOptions["onLoopResult"];
	private readonly onOperationFinished: PiDshAdapterOptions["onOperationFinished"];
	private readonly preparedMessages = new WeakMap<object, PreparedMessageEntry>();
	private readonly messageEntryIds = new WeakMap<object, string>();
	private readonly toolResultEntryIdsByCallId = new Map<string, string>();
	private readonly pendingToolContexts = new Map<string, BeforeToolCallContext>();
	private readonly persistedQueueEntryIds = new Set<string>();
	private activeRunId: string | null = null;
	private currentAssistantEntryId: string | null = null;
	private nextAssistantAttempt = 1;

	constructor(options: PiDshAdapterOptions) {
		this.store = options.store;
		this.baseContext = options.context;
		this.baseConfig = options.config;
		this.streamFn = options.streamFn;
		this.nextId = options.idGenerator ?? uuidv7;
		this.getRuntimeContributions = options.getRuntimeContributions ?? (() => ({}));
		this.replayForTool = options.replayForTool ?? (() => "never");
		this.onEvent = options.onEvent ?? (() => undefined);
		this.onLoopResult = options.onLoopResult;
		this.onOperationFinished = options.onOperationFinished;
	}

	async runPrompt(options: RunPromptOptions): Promise<AgentMessage[]> {
		const runId = this.nextId();
		const runtimeContributions = await this.snapshotRuntimeContributions();
		const sourceLeafId = await this.mainLeafId();
		const initialMessages = options.prompts.map((message) => this.prepareMessage(message).entry);
		await this.startRun(runId, sourceLeafId, {
			kind: "run",
			originalPrompt: structuredClone(options.prompts),
			initialMessages,
		});
		return this.runWithOperation(runId, options.signal, () =>
			runAgentLoop(
				options.prompts,
				this.contextForRun(cloneAgentContext(this.baseContext), runtimeContributions),
				this.wrapConfig(),
				this.persistingEventSink(),
				options.signal,
				this.snapshottingStreamFn(runtimeContributions),
			),
			runtimeContributions,
		);
	}

	async continue(options: ContinueOptions = {}): Promise<AgentMessage[]> {
		const runId = this.nextId();
		const runtimeContributions = await this.snapshotRuntimeContributions();
		const entries = await this.mainBranchEntries();
		const sessionContext = buildRepairSafeSessionContext(entries);
		const sourceLeafId = await this.mainLeafId();
		await this.startRun(runId, sourceLeafId, {
			kind: "run",
			originalPrompt: [],
			initialMessages: [],
		});
		return this.runWithOperation(
			runId,
			options.signal,
			() => this.continueActiveRun(sessionContext.messages, options.signal, runtimeContributions),
			runtimeContributions,
		);
	}

	private async runWithOperation(
		runId: string,
		signal: AbortSignal | undefined,
		operation: () => Promise<AgentMessage[]>,
		runtimeContributions: RuntimeContributionSnapshot,
	): Promise<AgentMessage[]> {
		this.activeRunId = runId;
		this.currentAssistantEntryId = null;
		this.nextAssistantAttempt = 1;
		let finishHookContext: OperationFinishedHookContext | undefined;
		try {
			let messages = await operation();
			if (this.onLoopResult !== undefined) {
				messages = await this.onLoopResult({
					runId,
					messages,
					continueRun: async () => this.continueActiveRun(undefined, signal, runtimeContributions),
				});
			}
			const terminal = messages.findLast((message) => message.role === "assistant");
			const outcome =
				signal?.aborted === true || (terminal?.role === "assistant" && terminal.stopReason === "aborted")
					? "aborted"
					: terminal?.role === "assistant" && terminal.stopReason === "error"
					? "failed"
					: "completed";
			const error =
				outcome === "failed"
					? { code: "PROVIDER_ERROR", message: terminal?.role === "assistant" ? terminal.errorMessage ?? "provider error" : "provider error" }
					: undefined;
			await this.finishRun(runId, outcome, error);
			finishHookContext = { runId, outcome, ...(error === undefined ? {} : { error }) };
			await this.onOperationFinished?.(finishHookContext);
			return messages;
		} catch (error) {
			if (finishHookContext === undefined) {
				const outcome = signal?.aborted === true ? "aborted" : "failed";
				const finishError =
					signal?.aborted === true
						? { code: "ABORTED", message: "operation aborted" }
						: { code: "LOOP_ERROR", message: error instanceof Error ? error.message : String(error) };
				await this.finishRun(runId, outcome, finishError);
				await this.onOperationFinished?.({ runId, outcome, error: finishError });
			}
			throw error;
		} finally {
			this.activeRunId = null;
			this.currentAssistantEntryId = null;
		}
	}

	private async continueActiveRun(
		messages: AgentMessage[] | undefined,
		signal: AbortSignal | undefined,
		runtimeContributions: RuntimeContributionSnapshot,
	): Promise<AgentMessage[]> {
		const durableMessages = messages ?? buildRepairSafeSessionContext(await this.mainBranchEntries()).messages;
		return runAgentLoopContinue(
			{
				systemPrompt: this.baseContext.systemPrompt,
				tools: this.wrapTools(this.combinedTools(this.baseContext.tools, runtimeContributions.tools)),
				messages: durableMessages,
			},
			this.wrapConfig(),
			this.persistingEventSink(),
			signal,
			this.snapshottingStreamFn(runtimeContributions),
		);
	}

	getActiveRunId(): string | null {
		return this.activeRunId;
	}

	async recordQueuedMessage(queue: "steer" | "followUp", message: AgentMessage): Promise<void> {
		const prepared = this.prepareMessage(message);
		await this.store.appendRecord({
			type: "queue_enqueued",
			id: this.nextId(),
			lane: "main",
			queue,
			runId: this.requireRunId(),
			target: prepared.entry,
		});
		this.persistedQueueEntryIds.add(prepared.id);
	}

	private async startRun(
		runId: string,
		sourceLeafId: string | null,
		intent: OperationStartedRecord["intent"],
	): Promise<void> {
		await this.store.appendRecord({
			type: "operation_started",
			id: runId,
			lane: "main",
			sourceLeafId,
			intent,
		});
	}

	private async finishRun(
		runId: string,
		outcome: OperationFinishedRecord["outcome"],
		error?: OperationFinishedRecord["error"],
	): Promise<void> {
		await this.store.appendRecord({
			type: "operation_finished",
			id: `${runId}-finished`,
			lane: "main",
			runId,
			outcome,
			...(error === undefined ? {} : { error }),
		});
	}

	private wrapConfig(): AgentLoopConfig {
		const config = this.baseConfig;
		return {
			...config,
			beforeToolCall: async (context, signal) => {
				const result = await config.beforeToolCall?.(context, signal);
				if (result?.block !== true && signal?.aborted !== true) {
					this.pendingToolContexts.set(context.toolCall.id, context);
				}
				return result;
			},
			afterToolCall: async (context, signal) => {
				const result = await config.afterToolCall?.(context, signal);
				return result;
			},
			getSteeringMessages:
				config.getSteeringMessages === undefined
					? undefined
					: async () => this.dequeueMessages("steer", config.getSteeringMessages!),
			getFollowUpMessages:
				config.getFollowUpMessages === undefined
					? undefined
					: async () => this.dequeueMessages("followUp", config.getFollowUpMessages!),
		};
	}

	private async dequeueMessages(
		queue: Extract<QueueEnqueuedRecord, { queue: "steer" | "followUp" }>["queue"],
		dequeue: () => Promise<AgentMessage[]>,
	): Promise<AgentMessage[]> {
		const messages = await dequeue();
		const runId = this.requireRunId();
		for (const message of messages) {
			const prepared = this.prepareMessage(message);
			if (this.persistedQueueEntryIds.delete(prepared.id)) continue;
			await this.store.appendRecord({
				type: "queue_enqueued",
				id: this.nextId(),
				lane: "main",
				queue,
				runId,
				target: prepared.entry,
			});
		}
		return messages;
	}

	private persistingEventSink(): AgentEventSink {
		return async (event) => {
			switch (event.type) {
				case "message_start":
					if (event.message.role === "assistant") {
						this.currentAssistantEntryId = this.prepareMessage(event.message).id;
						await this.store.appendRecord({
							type: "step_attempt",
							id: this.nextId(),
							lane: "main",
							runId: this.requireRunId(),
							step: "assistant",
							attempt: this.nextAssistantAttempt++,
							resultEntryId: this.currentAssistantEntryId,
						});
					}
					break;
				case "message_end": {
					const entry = await this.appendMessageOnce(event.message);
					if (event.message.role === "assistant") {
						this.currentAssistantEntryId = entry.id;
						await this.appendAssistantUsage(entry, toSessionStopReason(event.message.stopReason));
					} else if (event.message.role === "toolResult") {
						this.toolResultEntryIdsByCallId.set(event.message.toolCallId, entry.id);
						await this.appendToolUsage(entry, event.message);
					}
					break;
				}
				default:
					break;
			}
			await this.onEvent(event);
		};
	}

	private async appendMessageOnce(message: AgentMessage): Promise<MessageEntry> {
		const knownId = typeof message === "object" && message !== null ? this.messageEntryIds.get(message) : undefined;
		if (knownId !== undefined) {
			const entry = (await this.store.findEntriesOnBranch({
				start: knownId,
				order: "oldestFirst",
				limit: 1,
			}))[0];
			return entry as MessageEntry;
		}
		const prepared = this.prepareMessage(message);
		const entry = await this.store.appendEntry<MessageEntry>(prepared.entry, "main");
		if (typeof message === "object" && message !== null) this.messageEntryIds.set(message, entry.id);
		return entry;
	}

	private prepareMessage(message: AgentMessage): PreparedMessageEntry {
		if (typeof message === "object" && message !== null) {
			const existing = this.preparedMessages.get(message);
			if (existing !== undefined) return existing;
		}
		const id =
			typeof message === "object" && message !== null && message.role === "toolResult"
				? (this.toolResultEntryIdsByCallId.get(message.toolCallId) ?? this.nextId())
				: this.nextId();
		const entry = {
			type: "message",
			id,
			message: stripUndefinedJson(message) as AgentMessage,
		} satisfies ProvisionedEntry<MessageEntry>;
		const prepared = { id, entry };
		if (typeof message === "object" && message !== null) this.preparedMessages.set(message, prepared);
		return prepared;
	}

	private async persistToolStarted(context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> {
		const runId = this.requireRunId();
		const assistantEntryId = this.currentAssistantEntryId ?? this.messageEntryIds.get(context.assistantMessage);
		if (assistantEntryId === undefined) throw new Error("Cannot checkpoint tool call before assistant entry is durable");
		const resultEntryId = this.toolResultEntryIdsByCallId.get(context.toolCall.id) ?? this.nextId();
		this.toolResultEntryIdsByCallId.set(context.toolCall.id, resultEntryId);
		await this.store.appendRecord({
			type: "tool_started",
			id: this.nextId(),
			lane: "main",
			runId,
			assistantEntryId,
			toolIndex: context.assistantMessage.content.findIndex(
				(content) => content.type === "toolCall" && content.id === context.toolCall.id,
			),
			toolCallId: context.toolCall.id,
			toolName: context.toolCall.name,
			effectiveArgs: toJsonObject(context.args),
			resultEntryId,
			replay: this.replayForTool(context),
		});
		return undefined;
	}

	private async appendAssistantUsage(entry: MessageEntry, stopReason: SessionStopReason): Promise<void> {
		if (entry.message.role !== "assistant") return;
		await this.store.appendRecord({
			type: "usage",
			id: this.nextId(),
			lane: "main",
			cause: "assistant",
			runId: this.requireRunId(),
			entryId: entry.id,
			attempt: this.nextAssistantAttempt - 1,
			stopReason,
			usage: entry.message.usage,
		});
	}

	private async appendToolUsage(entry: MessageEntry, message: ToolResultMessage): Promise<void> {
		if (message.usage === undefined) return;
		await this.store.appendRecord({
			type: "usage",
			id: this.nextId(),
			lane: "main",
			cause: "tool",
			runId: this.requireRunId(),
			entryId: entry.id,
			toolCallId: message.toolCallId,
			usage: message.usage,
		});
	}

	private requireRunId(): string {
		if (this.activeRunId === null) throw new Error("No active run");
		return this.activeRunId;
	}

	private async mainLeafId(): Promise<string | null> {
		return (await this.store.getLanes()).find((lane) => lane.lane === "main")?.leafId ?? null;
	}

	private async mainBranchEntries(): Promise<Entry[]> {
		const leafId = await this.mainLeafId();
		return leafId === null
			? []
			: this.store.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
	}

	private contextForRun(context: AgentContext, runtimeContributions: RuntimeContributionSnapshot): AgentContext {
		return { ...context, tools: this.wrapTools(this.combinedTools(context.tools, runtimeContributions.tools)) };
	}

	private combinedTools(baseTools: AgentTool[] | undefined, runtimeTools: AgentTool[] | undefined): AgentTool[] | undefined {
		if (runtimeTools === undefined || runtimeTools.length === 0) return baseTools;
		if (baseTools === undefined || baseTools.length === 0) return [...runtimeTools];
		return [...baseTools, ...runtimeTools];
	}

	private wrapTools(tools: AgentTool[] | undefined): AgentTool[] | undefined {
		return tools?.map((tool) => ({
			...tool,
			execute: async (toolCallId, params, signal, onUpdate) => {
				const checkpointContext = this.pendingToolContexts.get(toolCallId);
				if (checkpointContext === undefined) throw new Error(`Missing durable checkpoint context for ${toolCallId}`);
				this.pendingToolContexts.delete(toolCallId);
				await this.persistToolStarted(checkpointContext);
				return tool.execute(toolCallId, params, signal, onUpdate);
			},
		}));
	}

	private snapshottingStreamFn(runtimeContributions: RuntimeContributionSnapshot): StreamFn {
		return async (model, context, options) => {
			const branchEntries = await this.mainBranchEntries();
			const snapshot = effectiveRequestSnapshot(
				model,
				context,
				options,
				foldConstraints(branchEntries),
				runtimeContributions.promptContributors,
			);
			await this.store.appendEntry(
				{
					type: "custom",
					id: this.nextId(),
					customType: REQUEST_HEADER_TYPE,
					data: snapshot.data,
				},
				"main",
			);
			return this.streamFn(model, snapshot.context, options);
		};
	}

	private async snapshotRuntimeContributions(): Promise<RuntimeContributionSnapshot> {
		const snapshot = await this.getRuntimeContributions();
		return {
			tools: snapshot.tools === undefined ? undefined : [...snapshot.tools],
			promptContributors:
				snapshot.promptContributors === undefined
					? undefined
					: snapshot.promptContributors.map((contributor) => structuredClone(contributor)),
		};
	}
}

function cloneAgentContext(context: AgentContext): AgentContext {
	return {
		systemPrompt: context.systemPrompt,
		messages: stripUndefinedJson(context.messages) as AgentMessage[],
		tools: context.tools,
	};
}

function toJsonObject(value: unknown): { [key: string]: unknown } {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return structuredClone(value) as { [key: string]: unknown };
	}
	return {};
}

function toSessionStopReason(stopReason: string): SessionStopReason {
	if (stopReason === "pending") throw new Error("Cannot persist pending assistant usage");
	return stopReason as SessionStopReason;
}
