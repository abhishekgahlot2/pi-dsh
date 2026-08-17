import { uuidv7, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../vendor/pi/types.ts";
import { convertToLlm } from "../vendor/pi/harness/messages.ts";
import type { NewRecord, AbortRequestedRecord } from "../vendor/pi/harness/session/types.ts";
import { PiDshLoopAdapter, type OperationFinishedHookContext, type RuntimeContributionSnapshot } from "./adapter.ts";
import { ComponentKernel, type ComponentDefinition } from "./component-kernel.ts";
import type { CompactionPolicy, CompactionResult, CompactionSummarizer } from "./compaction.ts";
import { appendConstraint, revokeConstraint } from "./constraints.ts";
import { createExtensionLifecycleTools, createPiToolsForExtensionRuntime, EXTENSION_LIFECYCLE_TOOL_NAMES } from "./extension-tools.ts";
import {
	ExtensionRuntime,
	type ExtensionDefinitionInput,
	type ExtensionReceipt,
	type ExtensionRevision,
	type JsonValue as ExtensionJsonValue,
	type RunningExtensionContribution,
} from "./extensions.ts";
import { repairInterruptedOperation, type RepairResult } from "./repair.ts";
import {
	DurableSessionHandle,
	DurableSessionRepository,
	type DurableSessionCreateOptions,
	type DurableSessionForkOptions,
} from "./repo.ts";
import { TurnCompactionController } from "./turn-runner.ts";
import {
	getSessionEventWindow,
	getSessionLineage,
	searchSessionEvents,
	traceSessionEvent,
} from "./session-query.ts";
import { createSessionQueryTools } from "./session-query-tools.ts";
import { stripUndefinedJson } from "./request-snapshot.ts";

export { ProviderResponseError } from "./turn-runner.ts";

// Public lifecycle owns repair-before-admission and ordered shutdown.

export type SessionEventListener = (event: AgentEvent) => void | Promise<void>;

export interface PiDshRuntimeOptions {
	repository: DurableSessionRepository;
	model: Model<Api>;
	streamFn: StreamFn;
	systemPrompt: string;
	tools?: AgentTool[];
	getRuntimeContributions?: (context: RuntimeContributionContext) => RuntimeContributionSnapshot | Promise<RuntimeContributionSnapshot>;
	postRunDrain?: (context: PostRunDrainContext) => void | Promise<void>;
	disposeRuntimeContributions?: (context: RuntimeDisposeContext) => void | Promise<void>;
	sessionsRoot?: string;
	summarizer?: CompactionSummarizer;
	compactionPolicy?: CompactionPolicy;
	loopConfig?: Omit<AgentLoopConfig, "model" | "convertToLlm" | "getSteeringMessages" | "getFollowUpMessages">;
	idGenerator?: () => string;
}

export interface RuntimeContributionContext {
	sessionId: string;
}

export interface PostRunDrainContext {
	sessionId: string;
	lastOperation: OperationFinishedHookContext | undefined;
}

export interface RuntimeDisposeContext {
	sessionId: string;
}

export interface RuntimeComponentSnapshot {
	id: string;
	kind: "provider" | "tools" | "prompt" | "session-query" | "extension-runtime";
	replaceable: boolean;
	status: "active" | "replacing" | "stopped" | "unavailable";
	details?: Record<string, unknown>;
}

export interface OpenedPiDshSession {
	session: PiDshSession;
	repair: RepairResult;
}

export type PiDshSessionErrorCode = "SESSION_CLOSED" | "SESSION_ACTIVE_RUN" | "SESSION_POST_RUN_DRAIN";

export class PiDshSessionError extends Error {
	constructor(
		readonly code: PiDshSessionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PiDshSessionError";
	}
}

export class PiDshRuntime {
	private readonly repository: DurableSessionRepository;
	private readonly options: Omit<PiDshRuntimeOptions, "repository">;
	private readonly handles = new WeakMap<PiDshSession, DurableSessionHandle>();

	constructor(options: PiDshRuntimeOptions) {
		const { repository, ...runtimeOptions } = options;
		this.repository = repository;
		this.options = { ...runtimeOptions, sessionsRoot: runtimeOptions.sessionsRoot ?? repository.sessionsRoot };
	}

	async createSession(options: DurableSessionCreateOptions): Promise<PiDshSession> {
		return this.compose(await this.repository.create(options));
	}

	async openSession(id: string): Promise<OpenedPiDshSession> {
		const handle = await this.repository.open(id);
		try {
			const repair = await repairInterruptedOperation(handle.storage);
			return { session: this.compose(handle), repair };
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	async forkSession(source: PiDshSession, options: DurableSessionForkOptions = {}): Promise<PiDshSession> {
		const sourceHandle = this.handles.get(source);
		if (sourceHandle === undefined) throw new Error("Source session does not belong to this runtime");
		const forkOptions = "scope" in options || "entryId" in options ? options : { ...options, scope: "tree" as const };
		return this.compose(await this.repository.fork(sourceHandle, forkOptions));
	}

	private compose(handle: DurableSessionHandle): PiDshSession {
		const session = new PiDshSession(handle, this.options);
		this.handles.set(session, handle);
		return session;
	}
}

export class PiDshSession {
	private readonly listeners = new Set<SessionEventListener>();
	private readonly steeringQueue: AgentMessage[] = [];
	private readonly followUpQueue: AgentMessage[] = [];
	private readonly adapter: PiDshLoopAdapter;
	private readonly turnController: TurnCompactionController;
	private readonly nextId: () => string;
	private readonly modelSnapshot: { provider: string; id: string; api: string };
	private readonly baseTools: AgentTool[] | undefined;
	private readonly getRuntimeContributions: () => Promise<RuntimeContributionSnapshot>;
	private readonly componentKernel: ComponentKernel;
	private readonly runtimeReady: Promise<SessionRuntimeState>;
	private accepting = true;
	private activeController: AbortController | undefined;
	private inFlight: Promise<AgentMessage[]> | undefined;
	private postRunDrain: Promise<void> | undefined;
	private abortRecordedForRun: string | undefined;
	private closePromise: Promise<void> | undefined;
	private lastOperation: OperationFinishedHookContext | undefined;

	constructor(
		private readonly handle: DurableSessionHandle,
		options: Omit<PiDshRuntimeOptions, "repository">,
	) {
		this.nextId = options.idGenerator ?? uuidv7;
		this.modelSnapshot = { provider: options.model.provider, id: options.model.id, api: options.model.api };
		this.baseTools = options.tools === undefined ? undefined : [...options.tools];
		this.componentKernel = new ComponentKernel({ isIdle: () => this.inFlight === undefined && this.postRunDrain === undefined });
		this.getRuntimeContributions = async () => {
			await this.runtimeReady;
			const external = await options.getRuntimeContributions?.({ sessionId: await this.sessionId() }) ?? {};
			const baseTools = this.componentKernel.get<readonly AgentTool[]>("tools:base")?.value ?? [];
			const basePrompts = this.componentKernel.get<readonly { id: string; text: string }[]>("prompt:base")?.value ?? [];
			const query = this.componentKernel.get<SessionQueryComponentValue>("session-query:default")?.value;
			const extension = this.componentKernel.get<ExtensionComponentValue>("extension-runtime:default")?.value;
			const extensionContributions = extension?.runtime.getContributions() ?? [];
			return mergeRuntimeContributions(
				{
					tools: [
						...baseTools,
						...(query?.tools ?? []),
						...(extension?.lifecycleTools ?? []),
						...(extension === undefined ? [] : createPiToolsForExtensionRuntime(extension.runtime)),
					],
					promptContributors: [
						...basePrompts,
						...extensionContributions.flatMap((contribution) =>
							contribution.prompts.map((prompt) => ({ id: `${contribution.extensionId}:${prompt.id}`, text: prompt.text })),
						),
					],
				},
				external,
			);
		};
		const userPrepareNextTurn = options.loopConfig?.prepareNextTurn;
		this.turnController = new TurnCompactionController(
			handle.storage,
			options.model,
			options.summarizer,
			options.compactionPolicy ?? {
				contextWindow: options.model.contextWindow,
				retainedTailTokens: Math.min(20_000, Math.floor(options.model.contextWindow / 4)),
			},
			() => this.adapter.getActiveRunId(),
		);
		this.adapter = new PiDshLoopAdapter({
			store: handle.storage,
			context: {
				systemPrompt: options.systemPrompt,
				messages: [],
				tools: undefined,
			},
			config: {
				...options.loopConfig,
				model: options.model,
				convertToLlm,
				getSteeringMessages: async () => this.steeringQueue.splice(0),
				getFollowUpMessages: async () => this.followUpQueue.splice(0),
				prepareNextTurn: async (context) => this.turnController.prepareNextTurn(context, userPrepareNextTurn),
			},
			streamFn: options.streamFn,
			idGenerator: this.nextId,
			getRuntimeContributions: this.getRuntimeContributions,
			onEvent: async (event) => {
				await Promise.allSettled(
					[...this.listeners].map(async (listener) => {
						await listener(event);
					}),
				);
			},
			onLoopResult: async (context) => this.turnController.recoverLoopResult(context),
			onOperationFinished: (context) => {
				this.lastOperation = context;
			},
		});
		this.disposeRuntimeContributions = async () => options.disposeRuntimeContributions?.({ sessionId: await this.sessionId() });
		this.drainPostRun = async () => {
			await this.runtimeReady;
			await this.currentExtensions().drainScheduledIntents();
			await options.postRunDrain?.({ sessionId: await this.sessionId(), lastOperation: this.lastOperation });
		};
		this.runtimeReady = this.initializeRuntime(options);
	}

	private readonly disposeRuntimeContributions: () => Promise<void>;
	private readonly drainPostRun: () => Promise<void>;

	get id(): Promise<string> {
		return this.sessionId();
	}

	prompt(prompt: string | AgentMessage[]): Promise<AgentMessage[]> {
		const messages =
			typeof prompt === "string"
				? [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }]
				: structuredClone(prompt);
		return this.startRun((signal) => this.adapter.runPrompt({ prompts: messages, signal }));
	}

	resume(): Promise<AgentMessage[]> {
		return this.startRun((signal) => this.adapter.continue({ signal }));
	}

	async steer(message: string | AgentMessage): Promise<void> {
		this.assertActiveRun("steer");
		const queued = toUserMessage(message);
		await this.adapter.recordQueuedMessage("steer", queued);
		this.steeringQueue.push(queued);
	}

	async followUp(message: string | AgentMessage): Promise<void> {
		this.assertActiveRun("queue a follow-up");
		const queued = toUserMessage(message);
		await this.adapter.recordQueuedMessage("followUp", queued);
		this.followUpQueue.push(queued);
	}

	async abort(): Promise<boolean> {
		const controller = this.activeController;
		const runId = this.adapter.getActiveRunId();
		if (controller === undefined || runId === null) return false;
		if (this.abortRecordedForRun !== runId) {
			const record: NewRecord<AbortRequestedRecord> = {
				type: "abort_requested",
				id: this.nextId(),
				lane: "main",
				runId,
			};
			await this.handle.storage.appendRecord(record);
			this.abortRecordedForRun = runId;
		}
		controller.abort();
		await this.inFlight?.catch(() => undefined);
		return true;
	}

	subscribe(listener: SessionEventListener): () => void {
		this.assertAccepting();
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	addConstraint(id: string, text: string): Promise<string> {
		this.assertIdle();
		return appendConstraint(this.handle.session, id, text);
	}

	revokeConstraint(id: string): Promise<string> {
		this.assertIdle();
		return revokeConstraint(this.handle.session, id);
	}

	compact(options: { reason?: "manual" | "threshold" | "overflow"; explicitCutEntryId?: string } = {}): Promise<CompactionResult | undefined> {
		this.assertIdle();
		return this.turnController.compactManual(options);
	}

	async inspectComponents(): Promise<RuntimeComponentSnapshot[]> {
		await this.runtimeReady;
		const contributions = await this.getRuntimeContributions();
		const baseTools = this.componentKernel.get<readonly AgentTool[]>("tools:base")?.value ?? [];
		const query = this.componentKernel.get<SessionQueryComponentValue>("session-query:default")?.value;
		const extension = this.componentKernel.get<ExtensionComponentValue>("extension-runtime:default")?.value;
		return this.componentKernel.snapshot().components.map((component) => ({
			id: component.id,
			kind: component.kind,
			replaceable: component.replaceable,
			status: component.status,
			details:
				component.id === "provider:default"
					? this.modelSnapshot
					: component.id === "tools:base"
						? { toolNames: baseTools.map((tool) => tool.name) }
						: component.id === "prompt:base"
							? { contributorIds: contributions.promptContributors?.map((contributor) => contributor.id) ?? [] }
							: component.id === "session-query:default"
								? { toolNames: query?.tools.map((tool) => tool.name) ?? [] }
								: component.id === "extension-runtime:default"
									? { lifecycleToolNames: extension?.lifecycleTools.map((tool) => tool.name) ?? [], running: extension?.runtime.getContributions().length ?? 0 }
									: undefined,
		}));
	}

	async inspectExtensions(): Promise<ReturnType<ExtensionRuntime["inspect"]>> {
		await this.runtimeReady;
		return this.currentExtensions().inspect();
	}

	async approveExtension(extensionId: string, revisionId: string, sourceHash: string): Promise<void> {
		this.assertIdle();
		await this.runtimeReady;
		await this.currentExtensions().approve({ sessionId: await this.sessionId(), extensionId, revisionId, sourceHash });
	}

	async defineExtension(input: ExtensionDefinitionInput): Promise<ExtensionRevision> {
		this.assertIdle();
		await this.runtimeReady;
		return this.currentExtensions().define(input);
	}

	async updateExtension(input: ExtensionDefinitionInput): Promise<ExtensionRevision> {
		return this.defineExtension(input);
	}

	async runExtension(extensionId: string, revisionId: string): Promise<RunningExtensionContribution> {
		this.assertIdle();
		await this.runtimeReady;
		return this.currentExtensions().run({ sessionId: await this.sessionId(), extensionId, revisionId });
	}

	async stopExtension(extensionId: string): Promise<void> {
		this.assertIdle();
		await this.runtimeReady;
		await this.currentExtensions().stop({ sessionId: await this.sessionId(), extensionId });
	}

	async rollbackExtension(extensionId: string, revisionId: string): Promise<RunningExtensionContribution> {
		this.assertIdle();
		await this.runtimeReady;
		return this.currentExtensions().rollback({ sessionId: await this.sessionId(), extensionId, revisionId });
	}

	async removeExtension(extensionId: string): Promise<void> {
		this.assertIdle();
		await this.runtimeReady;
		await this.currentExtensions().remove({ sessionId: await this.sessionId(), extensionId });
	}

	async replaceComponent<Value>(id: string, definition: ComponentDefinition<Value>): Promise<void> {
		this.assertIdle();
		await this.runtimeReady;
		await this.componentKernel.replace(id, definition);
	}

	async close(): Promise<void> {
		this.closePromise ??= this.closeInOrder();
		await this.closePromise;
	}

	private startRun(run: (signal: AbortSignal) => Promise<AgentMessage[]>): Promise<AgentMessage[]> {
		this.assertIdle();
		const controller = new AbortController();
		this.activeController = controller;
		this.abortRecordedForRun = undefined;
		const operation = run(controller.signal).finally(async () => {
			this.activeController = undefined;
			this.inFlight = undefined;
			this.postRunDrain = this.runPostRunDrain();
			await this.postRunDrain;
		});
		this.inFlight = operation;
		return operation;
	}

	private assertAccepting(): void {
		if (!this.accepting) throw new PiDshSessionError("SESSION_CLOSED", "Session is closed to new work");
	}

	private assertIdle(): void {
		this.assertAccepting();
		if (this.postRunDrain !== undefined) {
			throw new PiDshSessionError("SESSION_POST_RUN_DRAIN", "Session is applying post-run deferred work");
		}
		if (this.inFlight !== undefined) throw new PiDshSessionError("SESSION_ACTIVE_RUN", "Session already has an active run");
	}

	private assertActiveRun(action: string): void {
		this.assertAccepting();
		if (this.inFlight === undefined || this.adapter.getActiveRunId() === null) {
			throw new Error(`Cannot ${action} without an active run`);
		}
	}

	private async sessionId(): Promise<string> {
		return (await this.handle.session.getMetadata()).id;
	}

	private async runPostRunDrain(): Promise<void> {
		try {
			await this.drainPostRun();
		} finally {
			this.postRunDrain = undefined;
		}
	}

	private async initializeRuntime(options: Omit<PiDshRuntimeOptions, "repository">): Promise<SessionRuntimeState> {
		const sessionId = await this.sessionId();
		const sessionsRoot = options.sessionsRoot;
		const queryTools = sessionsRoot === undefined ? [] : createSessionQueryTools({ sessionsRoot });
		const extensions = new ExtensionRuntime({
			sessionId,
			reservedToolNames: [
				...(this.baseTools?.map((tool) => tool.name) ?? []),
				...queryTools.map((tool) => tool.name),
				...EXTENSION_LIFECYCLE_TOOL_NAMES,
			],
			querySession: async (request) => sessionsRoot === undefined ? null : dispatchExtensionQuery(sessionsRoot, request),
			onReceipt: async (receipt) => this.appendExtensionReceipt(receipt),
		});
		const lifecycleTools = createExtensionLifecycleTools(extensions, { getRunId: () => this.adapter.getActiveRunId() });
		const baseToolNames = new Set(this.baseTools?.map((tool) => tool.name) ?? []);
		for (const tool of [...queryTools, ...lifecycleTools]) {
			if (baseToolNames.has(tool.name)) throw new Error(`Runtime tool duplicates base tool: ${tool.name}`);
			baseToolNames.add(tool.name);
		}

		await this.componentKernel.activate({ id: "provider:default", kind: "provider", replaceable: false, activate: () => this.modelSnapshot });
		await this.componentKernel.activate({ id: "tools:base", kind: "tools", replaceable: true, activate: () => this.baseTools ?? [] });
		await this.componentKernel.activate({ id: "prompt:base", kind: "prompt", replaceable: true, activate: () => [] });
		await this.componentKernel.activate<SessionQueryComponentValue>({ id: "session-query:default", kind: "session-query", replaceable: true, activate: () => ({ sessionsRoot, tools: queryTools }) });
		await this.componentKernel.activate({
			id: "extension-runtime:default",
			kind: "extension-runtime",
			replaceable: true,
			dependencies: ["session-query:default", "tools:base", "prompt:base"],
			activate: () => ({ value: { runtime: extensions, lifecycleTools } satisfies ExtensionComponentValue, dispose: () => extensions.close() }),
		});
		return { initialized: true };
	}

	private currentExtensions(): ExtensionRuntime {
		const extension = this.componentKernel.get<ExtensionComponentValue>("extension-runtime:default")?.value;
		if (extension === undefined) throw new Error("Extension runtime component is unavailable");
		return extension.runtime;
	}

	private async appendExtensionReceipt(receipt: ExtensionReceipt): Promise<void> {
		const { type, intent, ...rest } = receipt;
		const data = stripUndefinedJson(intent === undefined ? rest : { ...rest, ...intent }) as Record<string, unknown>;
		await this.handle.session.appendCustomEntry(type, data);
	}

	private async closeInOrder(): Promise<void> {
		this.accepting = false;
		const errors: unknown[] = [];
		await captureCloseError(errors, () => this.abort());
		await captureCloseError(errors, async () => { await this.inFlight; });
		await captureCloseError(errors, async () => { await this.postRunDrain; });
		await captureCloseError(errors, async () => {
			await this.runtimeReady;
			await this.componentKernel.dispose();
		});
		await captureCloseError(errors, this.disposeRuntimeContributions);
		await captureCloseError(errors, () => this.handle.drain());
		await captureCloseError(errors, () => this.handle.close());
		this.listeners.clear();
		if (errors.length > 0) throw new AggregateError(errors, "Session shutdown completed with errors");
	}
}

interface SessionRuntimeState {
	readonly initialized: true;
}

interface SessionQueryComponentValue {
	readonly sessionsRoot?: string;
	readonly tools: readonly AgentTool[];
}

interface ExtensionComponentValue {
	readonly runtime: ExtensionRuntime;
	readonly lifecycleTools: readonly AgentTool[];
}

function mergeRuntimeContributions(
	internal: RuntimeContributionSnapshot,
	external: RuntimeContributionSnapshot,
): RuntimeContributionSnapshot {
	return {
		tools: [...(internal.tools ?? []), ...(external.tools ?? [])],
		promptContributors: [...(internal.promptContributors ?? []), ...(external.promptContributors ?? [])],
	};
}

async function captureCloseError(errors: unknown[], step: () => void | Promise<unknown>): Promise<void> {
	try {
		await step();
	} catch (error) {
		errors.push(error);
	}
}

async function dispatchExtensionQuery(sessionsRoot: string, request: ExtensionJsonValue): Promise<ExtensionJsonValue> {
	if (!isExtensionObject(request)) {
		throw new Error("Extension query request must be an object");
	}
	const action = request.action;
	if (typeof action !== "string") throw new Error("Extension query request requires an action");
	let result: unknown;
	switch (action) {
		case "search":
			result = await searchSessionEvents(sessionsRoot, {
				text: typeof request.text === "string" ? request.text : "",
				limit: typeof request.limit === "number" ? request.limit : undefined,
				cursor: typeof request.cursor === "string" ? request.cursor : undefined,
			});
			break;
		case "window":
			result = await getSessionEventWindow(
				sessionsRoot,
				requireQueryString(request, "sessionId"),
				requireQueryNumber(request, "seq"),
				{
					before: typeof request.before === "number" ? request.before : undefined,
					after: typeof request.after === "number" ? request.after : undefined,
				},
			);
			break;
		case "trace":
			result = await traceSessionEvent(sessionsRoot, requireQueryString(request, "sessionId"), requireQueryNumber(request, "seq"));
			break;
		case "lineage":
			result = await getSessionLineage(sessionsRoot, requireQueryString(request, "sessionId"));
			break;
		default:
			throw new Error(`Unknown extension query action: ${action}`);
	}
	return structuredClone(result) as ExtensionJsonValue;
}

function isExtensionObject(value: ExtensionJsonValue): value is Readonly<Record<string, ExtensionJsonValue>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireQueryString(request: Readonly<Record<string, ExtensionJsonValue>>, field: string): string {
	const value = request[field];
	if (typeof value !== "string") throw new Error(`Extension query ${field} must be a string`);
	return value;
}

function requireQueryNumber(request: Readonly<Record<string, ExtensionJsonValue>>, field: string): number {
	const value = request[field];
	if (typeof value !== "number") throw new Error(`Extension query ${field} must be a number`);
	return value;
}

function toUserMessage(message: string | AgentMessage): AgentMessage {
	return typeof message === "string"
		? { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }
		: structuredClone(message);
}
