import { uuidv7, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../vendor/pi/types.ts";
import { convertToLlm } from "../vendor/pi/harness/messages.ts";
import type { NewRecord, AbortRequestedRecord } from "../vendor/pi/harness/session/types.ts";
import { PiDshLoopAdapter } from "./adapter.ts";
import type { CompactionPolicy, CompactionResult, CompactionSummarizer } from "./compaction.ts";
import { appendConstraint, revokeConstraint } from "./constraints.ts";
import { repairInterruptedOperation, type RepairResult } from "./repair.ts";
import {
	DurableSessionHandle,
	DurableSessionRepository,
	type DurableSessionCreateOptions,
	type DurableSessionForkOptions,
} from "./repo.ts";
import { TurnCompactionController } from "./turn-runner.ts";

export { ProviderResponseError } from "./turn-runner.ts";

// Public lifecycle owns repair-before-admission and ordered shutdown.

export type SessionEventListener = (event: AgentEvent) => void | Promise<void>;

export interface PiDshRuntimeOptions {
	repository: DurableSessionRepository;
	model: Model<Api>;
	streamFn: StreamFn;
	systemPrompt: string;
	tools?: AgentTool[];
	summarizer?: CompactionSummarizer;
	compactionPolicy?: CompactionPolicy;
	loopConfig?: Omit<AgentLoopConfig, "model" | "convertToLlm" | "getSteeringMessages" | "getFollowUpMessages">;
	idGenerator?: () => string;
}

export interface OpenedPiDshSession {
	session: PiDshSession;
	repair: RepairResult;
}

export class PiDshRuntime {
	private readonly repository: DurableSessionRepository;
	private readonly options: Omit<PiDshRuntimeOptions, "repository">;
	private readonly handles = new WeakMap<PiDshSession, DurableSessionHandle>();

	constructor(options: PiDshRuntimeOptions) {
		const { repository, ...runtimeOptions } = options;
		this.repository = repository;
		this.options = runtimeOptions;
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
	private accepting = true;
	private activeController: AbortController | undefined;
	private inFlight: Promise<AgentMessage[]> | undefined;
	private abortRecordedForRun: string | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(
		private readonly handle: DurableSessionHandle,
		options: Omit<PiDshRuntimeOptions, "repository">,
	) {
		this.nextId = options.idGenerator ?? uuidv7;
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
				tools: options.tools,
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
			onEvent: async (event) => {
				await Promise.allSettled(
					[...this.listeners].map(async (listener) => {
						await listener(event);
					}),
				);
			},
			onLoopResult: async (context) => this.turnController.recoverLoopResult(context),
		});
	}

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

	async close(): Promise<void> {
		this.closePromise ??= this.closeInOrder();
		await this.closePromise;
	}

	private startRun(run: (signal: AbortSignal) => Promise<AgentMessage[]>): Promise<AgentMessage[]> {
		this.assertIdle();
		const controller = new AbortController();
		this.activeController = controller;
		this.abortRecordedForRun = undefined;
		const operation = run(controller.signal).finally(() => {
			this.activeController = undefined;
			this.inFlight = undefined;
		});
		this.inFlight = operation;
		return operation;
	}

	private assertAccepting(): void {
		if (!this.accepting) throw new Error("Session is closed to new work");
	}

	private assertIdle(): void {
		this.assertAccepting();
		if (this.inFlight !== undefined) throw new Error("Session already has an active run");
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


	private async closeInOrder(): Promise<void> {
		this.accepting = false;
		await this.abort();
		await this.inFlight?.catch(() => undefined);
		await this.handle.drain();
		await this.handle.close();
		this.listeners.clear();
	}
}

function toUserMessage(message: string | AgentMessage): AgentMessage {
	return typeof message === "string"
		? { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }
		: structuredClone(message);
}
