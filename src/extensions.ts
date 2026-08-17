import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { extensionWorkerSource } from "./extension-worker.ts";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ExtensionAction = "define" | "run" | "stop" | "update" | "rollback" | "remove";
export type ExtensionReceiptType =
	| "extension/intent-scheduled"
	| "extension/defined"
	| "extension/approved"
	| "extension/started"
	| "extension/stopped"
	| "extension/updated"
	| "extension/rolled-back"
	| "extension/removed"
	| "extension/failed";

export type ExtensionErrorCode =
	| "EXTENSION_INTENT_SCHEDULED"
	| "EXTENSION_SOURCE_SYNTAX"
	| "EXTENSION_SOURCE_EVALUATION_FAILED"
	| "EXTENSION_ACTIVATION_FAILED"
	| "EXTENSION_ACTIVATION_TIMEOUT"
	| "EXTENSION_INVALID_ACTIVATION_RESULT"
	| "EXTENSION_MANIFEST_MISMATCH"
	| "EXTENSION_HANDLER_FAILED"
	| "EXTENSION_HANDLER_TIMEOUT"
	| "EXTENSION_RESULT_NOT_JSON"
	| "EXTENSION_WORKER_CRASHED"
	| "EXTENSION_WORKER_PROTOCOL_ERROR"
	| "EXTENSION_WORKER_LATE_RESPONSE"
	| "EXTENSION_NOT_APPROVED"
	| "EXTENSION_SESSION_MISMATCH"
	| "EXTENSION_DISPOSE_TIMEOUT"
	| "EXTENSION_SOURCE_CHANGED"
	| "EXTENSION_NOT_FOUND"
	| "EXTENSION_ALREADY_RUNNING";

export class ExtensionRuntimeError extends Error {
	constructor(
		readonly code: ExtensionErrorCode,
		message: string,
		readonly details?: JsonValue,
	) {
		super(message);
		this.name = "ExtensionRuntimeError";
	}
}

export interface ExtensionToolDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: JsonValue;
}

export interface ExtensionPromptDeclaration {
	readonly id: string;
	readonly text: string;
}

export interface ExtensionContributionManifest {
	readonly tools?: readonly ExtensionToolDeclaration[];
	readonly prompts?: readonly ExtensionPromptDeclaration[];
}

export interface ExtensionDefinitionInput {
	readonly extensionId: string;
	readonly purpose: string;
	readonly source: string;
	readonly manifest: ExtensionContributionManifest;
	readonly metadata?: JsonValue;
}

export interface ExtensionRevision {
	readonly extensionId: string;
	readonly revisionId: string;
	readonly source: string;
	readonly sourceHash: string;
	readonly purpose: string;
	readonly manifest: ExtensionContributionManifest;
	readonly metadata?: JsonValue;
	readonly approved: boolean;
	readonly approvedAt?: number;
}

export interface ExtensionIntentReceipt {
	readonly intentId: string;
	readonly sessionId: string;
	readonly extensionId: string;
	readonly revisionId?: string;
	readonly sourceHash?: string;
	readonly runId: string;
	readonly toolCallId: string;
	readonly requestedAction: ExtensionAction;
}

export interface ExtensionScheduledIntent extends ExtensionIntentReceipt {
	readonly definition?: ExtensionDefinitionInput;
}

export interface ExtensionReceipt {
	readonly type: ExtensionReceiptType;
	readonly sessionId: string;
	readonly extensionId: string;
	readonly revisionId?: string;
	readonly sourceHash?: string;
	readonly status: "scheduled-for-next-turn" | "ok" | "failed";
	readonly code?: ExtensionErrorCode;
	readonly message?: string;
	readonly metadata?: JsonValue;
	readonly intent?: ExtensionIntentReceipt;
	readonly intentId?: string;
}

export interface RegisteredExtensionTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonValue;
	readonly execute: (args: JsonValue, context: { readonly signal?: AbortSignal; readonly toolCallId: string }) => Promise<JsonValue>;
}

export interface RunningExtensionContribution {
	readonly sessionId: string;
	readonly extensionId: string;
	readonly revisionId: string;
	readonly sourceHash: string;
	readonly tools: readonly RegisteredExtensionTool[];
	readonly prompts: readonly ExtensionPromptDeclaration[];
}

export interface ExtensionRuntimeOptions {
	readonly sessionId: string;
	readonly activationTimeoutMs?: number;
	readonly handlerTimeoutMs?: number;
	readonly abortGraceMs?: number;
	readonly disposeTimeoutMs?: number;
	readonly idGenerator?: () => string;
	readonly now?: () => number;
	readonly querySession?: (request: JsonValue) => Promise<JsonValue> | JsonValue;
	readonly onReceipt?: (receipt: ExtensionReceipt) => void | Promise<void>;
	readonly onWorkerObservation?: (observation: { readonly code: ExtensionErrorCode; readonly message: string }) => void;
	readonly reservedToolNames?: readonly string[];
}

interface ExtensionDefinition {
	readonly extensionId: string;
	readonly revisions: readonly ExtensionRevision[];
	readonly activeRevisionId?: string;
}

interface BufferedRegistrations {
	readonly tools: ExtensionToolRegistration[];
	readonly prompts: ExtensionPromptDeclaration[];
}

interface ExtensionToolRegistration {
	readonly manifest: ExtensionToolDeclaration;
}

type PendingCall =
	| {
			readonly kind: "activation";
			readonly requestId: string;
			readonly resolve: (value: unknown) => void;
			readonly reject: (error: ExtensionRuntimeError) => void;
			readonly timeout: NodeJS.Timeout;
	  }
	| {
			readonly kind: "handler";
			readonly requestId: string;
			readonly toolName: string;
			readonly controller: AbortController;
			readonly resolve: (value: JsonValue) => void;
			readonly reject: (error: ExtensionRuntimeError) => void;
			readonly timeout: NodeJS.Timeout;
	  };

interface WorkerEnvelope {
	readonly type?: unknown;
	readonly requestId?: unknown;
	readonly ok?: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly manifest?: unknown;
	readonly payload?: unknown;
}

interface RunningRevision {
	readonly revision: ExtensionRevision;
	readonly worker: Worker;
	readonly pending: Map<string, PendingCall>;
	readonly buffered: BufferedRegistrations;
	readonly contribution: RunningExtensionContribution;
	terminated: boolean;
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 1_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 1_000;
const DEFAULT_ABORT_GRACE_MS = 50;
const DEFAULT_DISPOSE_TIMEOUT_MS = 1_000;
const FORBIDDEN_SOURCE_PATTERN = /\b(?:import|export)\b|import\s*\(/;
const MAX_EXTENSION_SOURCE_BYTES = 64 * 1024;
const MAX_EXTENSION_METADATA_BYTES = 16 * 1024;
const MAX_EXTENSION_CONTRIBUTIONS = 16;
const MAX_EXTENSION_PROMPT_BYTES = 8 * 1024;

export function hashExtensionSource(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

export function validateExtensionSource(source: string): void {
	const trimmed = source.trim();
	if (Buffer.byteLength(trimmed) > MAX_EXTENSION_SOURCE_BYTES) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", `Extension source exceeds ${MAX_EXTENSION_SOURCE_BYTES} bytes`);
	}
	if (FORBIDDEN_SOURCE_PATTERN.test(trimmed)) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Extension source cannot import or export code");
	}
	const unwrapped = trimmed.startsWith("(") && trimmed.endsWith(")") ? trimmed.slice(1, -1).trim() : trimmed;
	if (/\}\s*;/.test(unwrapped)) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Extension source must contain only one top-level async expression");
	}
	if (!/^async\s*\(\s*ctx\s*\)\s*=>\s*\{[\s\S]*\}$/.test(unwrapped)) {
		throw new ExtensionRuntimeError(
			"EXTENSION_SOURCE_SYNTAX",
			"Extension source must be exactly one async function expression: async (ctx) => { ... }",
		);
	}
}

export function validateExtensionDefinitionInput(input: ExtensionDefinitionInput): void {
	assertExtensionId(input.extensionId);
	if (!input.purpose.trim() || input.purpose.length > 512) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Extension purpose must contain 1 to 512 characters");
	}
	assertJsonValue(input.metadata ?? null, "metadata");
	if (Buffer.byteLength(JSON.stringify(input.metadata ?? null)) > MAX_EXTENSION_METADATA_BYTES) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", `Extension metadata exceeds ${MAX_EXTENSION_METADATA_BYTES} bytes`);
	}
	validateManifest(input.manifest);
	validateExtensionSource(input.source);
}

export class ExtensionRuntime {
	private readonly definitions = new Map<string, ExtensionDefinition>();
	private readonly running = new Map<string, RunningRevision>();
	private readonly scheduled: ExtensionScheduledIntent[] = [];
	private readonly activationTimeoutMs: number;
	private readonly handlerTimeoutMs: number;
	private readonly abortGraceMs: number;
	private readonly disposeTimeoutMs: number;
	private readonly nextId: () => string;
	private readonly clock: () => number;
	private readonly query: (request: JsonValue) => Promise<JsonValue> | JsonValue;
	private readonly receiptSink: (receipt: ExtensionReceipt) => void | Promise<void>;
	private readonly observeWorker: (observation: { readonly code: ExtensionErrorCode; readonly message: string }) => void;
	private readonly reservedToolNames: ReadonlySet<string>;

	constructor(private readonly options: ExtensionRuntimeOptions) {
		this.activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
		this.handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
		this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
		this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
		this.nextId = options.idGenerator ?? randomUUID;
		this.clock = options.now ?? Date.now;
		this.query = options.querySession ?? (() => null);
		this.receiptSink = options.onReceipt ?? (() => undefined);
		this.observeWorker = options.onWorkerObservation ?? (() => undefined);
		this.reservedToolNames = new Set(options.reservedToolNames ?? []);
	}

	get sessionId(): string {
		return this.options.sessionId;
	}

	inspect(): {
		readonly sessionId: string;
		readonly trust: string;
		readonly containment: string;
		readonly definitions: readonly ExtensionDefinition[];
		readonly running: readonly RunningExtensionContribution[];
		readonly scheduled: readonly ExtensionIntentReceipt[];
	} {
		return {
			sessionId: this.sessionId,
			trust: "Approved host JavaScript is trusted local code equivalent to a powerful local tool/bash.",
			containment: "worker_threads plus node:vm provide lifecycle containment/preemption only, not a security boundary.",
			definitions: [...this.definitions.values()].map(cloneDefinition),
			running: [...this.running.values()].map((item) => item.contribution),
			scheduled: this.scheduled.map(({ definition: _definition, ...intent }) => structuredClone(intent)),
		};
	}

	async scheduleIntent(input: {
		readonly requestedAction: ExtensionAction;
		readonly extensionId: string;
		readonly revisionId?: string;
		readonly sourceHash?: string;
		readonly runId: string;
		readonly toolCallId: string;
		readonly definition?: ExtensionDefinitionInput;
	}): Promise<ExtensionIntentReceipt> {
		const scheduled: ExtensionScheduledIntent = {
			intentId: this.nextId(),
			sessionId: this.sessionId,
			extensionId: input.extensionId,
			revisionId: input.revisionId,
			sourceHash: input.sourceHash,
			runId: input.runId,
			toolCallId: input.toolCallId,
			requestedAction: input.requestedAction,
			...(input.definition === undefined ? {} : { definition: structuredClone(input.definition) }),
		};
		this.scheduled.push(scheduled);
		const { definition: _definition, ...receipt } = scheduled;
		try {
			await this.emit({
				type: "extension/intent-scheduled",
				sessionId: this.sessionId,
				extensionId: input.extensionId,
				revisionId: input.revisionId,
				sourceHash: input.sourceHash,
				status: "scheduled-for-next-turn",
				code: "EXTENSION_INTENT_SCHEDULED",
				intent: receipt,
			});
		} catch (error) {
			const index = this.scheduled.findIndex((candidate) => candidate.intentId === scheduled.intentId);
			if (index >= 0) this.scheduled.splice(index, 1);
			throw error;
		}
		return receipt;
	}

	async drainScheduledIntents(): Promise<void> {
		const scheduled = this.scheduled.splice(0);
		for (const intent of scheduled) {
			try {
				switch (intent.requestedAction) {
					case "define":
					case "update":
						if (intent.definition === undefined) {
							throw new ExtensionRuntimeError("EXTENSION_SOURCE_CHANGED", "Scheduled definition payload is unavailable");
						}
						await this.define(intent.definition, intent.intentId);
						break;
					case "run":
						if (intent.revisionId === undefined) throw new ExtensionRuntimeError("EXTENSION_NOT_FOUND", "Run requires a revision id");
						await this.run({ sessionId: intent.sessionId, extensionId: intent.extensionId, revisionId: intent.revisionId }, intent.intentId);
						break;
					case "stop":
						await this.stop({ sessionId: intent.sessionId, extensionId: intent.extensionId }, intent.intentId);
						break;
					case "rollback":
						if (intent.revisionId === undefined) throw new ExtensionRuntimeError("EXTENSION_NOT_FOUND", "Rollback requires a revision id");
						await this.rollback({ sessionId: intent.sessionId, extensionId: intent.extensionId, revisionId: intent.revisionId }, intent.intentId);
						break;
					case "remove":
						await this.remove({ sessionId: intent.sessionId, extensionId: intent.extensionId }, intent.intentId);
						break;
				}
			} catch (error) {
				const normalized = toExtensionError(error);
				await this.emit({
					type: "extension/failed",
					sessionId: this.sessionId,
					extensionId: intent.extensionId,
					revisionId: intent.revisionId,
					sourceHash: intent.sourceHash,
					status: "failed",
					code: normalized.code,
					message: normalized.message,
					intentId: intent.intentId,
				});
			}
		}
	}

	async define(input: ExtensionDefinitionInput, intentId?: string): Promise<ExtensionRevision> {
		validateExtensionDefinitionInput(input);
		for (const tool of input.manifest.tools ?? []) {
			if (this.reservedToolNames.has(tool.name)) {
				throw new ExtensionRuntimeError("EXTENSION_MANIFEST_MISMATCH", `Extension tool conflicts with reserved tool: ${tool.name}`);
			}
		}
		const revision = freezeRevision({
			extensionId: input.extensionId,
			revisionId: this.nextId(),
			source: input.source,
			sourceHash: hashExtensionSource(input.source),
			purpose: input.purpose,
			manifest: cloneManifest(input.manifest),
			metadata: input.metadata,
			approved: false,
		});
		const existing = this.definitions.get(input.extensionId);
		const updated: ExtensionDefinition = {
			extensionId: input.extensionId,
			revisions: existing === undefined ? [revision] : [...existing.revisions, revision],
			activeRevisionId: existing?.activeRevisionId,
		};
		this.definitions.set(input.extensionId, updated);
		try {
			await this.emit({
				type: existing === undefined ? "extension/defined" : "extension/updated",
				sessionId: this.sessionId,
				extensionId: revision.extensionId,
				revisionId: revision.revisionId,
				sourceHash: revision.sourceHash,
				status: "ok",
				intentId,
				metadata: receiptMetadata(revision),
			});
		} catch (error) {
			if (existing === undefined) this.definitions.delete(input.extensionId);
			else this.definitions.set(input.extensionId, existing);
			throw error;
		}
		return revision;
	}

	async approve(input: {
		readonly sessionId: string;
		readonly extensionId: string;
		readonly revisionId: string;
		readonly sourceHash: string;
	}): Promise<ExtensionRevision> {
		this.assertSession(input.sessionId);
		const revision = this.findRevision(input.extensionId, input.revisionId);
		if (revision.sourceHash !== input.sourceHash) {
			throw new ExtensionRuntimeError("EXTENSION_SOURCE_CHANGED", "Approval source hash does not match the immutable revision");
		}
		const approved = freezeRevision({ ...revision, approved: true, approvedAt: this.clock() });
		this.replaceRevision(approved);
		try {
			await this.emit({
				type: "extension/approved",
				sessionId: this.sessionId,
				extensionId: approved.extensionId,
				revisionId: approved.revisionId,
				sourceHash: approved.sourceHash,
				status: "ok",
				metadata: receiptMetadata(approved),
			});
		} catch (error) {
			this.replaceRevision(revision);
			throw error;
		}
		return approved;
	}

	async run(input: { readonly sessionId: string; readonly extensionId: string; readonly revisionId: string }, intentId?: string): Promise<RunningExtensionContribution> {
		this.assertSession(input.sessionId);
		const revision = this.findRevision(input.extensionId, input.revisionId);
		if (!revision.approved) {
			throw new ExtensionRuntimeError("EXTENSION_NOT_APPROVED", "Extension revision must be approved before running");
		}
		if (this.running.has(input.extensionId)) {
			throw new ExtensionRuntimeError("EXTENSION_ALREADY_RUNNING", "Extension is already running");
		}
		const running = this.createRunningRevision(revision);
		this.running.set(input.extensionId, running);
		try {
			await this.activate(running);
			this.assertManifestMatch(revision, running.buffered);
			this.markActive(revision.extensionId, revision.revisionId);
			await this.emit({
				type: "extension/started",
				sessionId: this.sessionId,
				extensionId: revision.extensionId,
				revisionId: revision.revisionId,
				sourceHash: revision.sourceHash,
					status: "ok",
					intentId,
				metadata: receiptMetadata(revision),
			});
			return running.contribution;
		} catch (error) {
			this.running.delete(input.extensionId);
			await this.terminateRunning(running, toExtensionError(error).code);
			await this.emitFailure(revision, toExtensionError(error));
			throw error;
		}
	}

	async stop(input: { readonly sessionId: string; readonly extensionId: string }, intentId?: string): Promise<void> {
		this.assertSession(input.sessionId);
		const running = this.running.get(input.extensionId);
		if (running === undefined) return;
		this.running.delete(input.extensionId);
		const revision = running.revision;
		let code: ExtensionErrorCode | undefined;
		try {
			await this.stopRunning(running);
		} catch (error) {
			code = toExtensionError(error).code;
		}
		this.markActive(input.extensionId, undefined);
		await this.emit({
			type: "extension/stopped",
			sessionId: this.sessionId,
			extensionId: revision.extensionId,
			revisionId: revision.revisionId,
			sourceHash: revision.sourceHash,
			status: code === undefined ? "ok" : "failed",
			intentId,
			code,
			metadata: receiptMetadata(revision),
		});
		if (code !== undefined) throw new ExtensionRuntimeError(code, "Extension stop did not quiesce cleanly");
	}

	async rollback(input: { readonly sessionId: string; readonly extensionId: string; readonly revisionId: string }, intentId?: string): Promise<RunningExtensionContribution> {
		await this.stop({ sessionId: input.sessionId, extensionId: input.extensionId }, intentId);
		const contribution = await this.run(input, intentId);
		await this.emit({
			type: "extension/rolled-back",
			sessionId: this.sessionId,
			extensionId: input.extensionId,
			revisionId: input.revisionId,
			sourceHash: contribution.sourceHash,
			status: "ok",
			intentId,
		});
		return contribution;
	}

	async remove(input: { readonly sessionId: string; readonly extensionId: string }, intentId?: string): Promise<void> {
		this.assertSession(input.sessionId);
		await this.stop(input);
		this.definitions.delete(input.extensionId);
		await this.emit({
			type: "extension/removed",
			sessionId: this.sessionId,
			extensionId: input.extensionId,
			status: "ok",
			intentId,
		});
	}

	getContributions(): RunningExtensionContribution[] {
		return [...this.running.values()].map((running) => running.contribution);
	}

	async close(): Promise<void> {
		const stops = [...this.running.keys()].map((extensionId) => this.stop({ sessionId: this.sessionId, extensionId }));
		await Promise.allSettled(stops);
	}

	private createRunningRevision(revision: ExtensionRevision): RunningRevision {
		const buffered: BufferedRegistrations = { tools: [], prompts: [] };
		const worker = new Worker(extensionWorkerSource, {
			eval: true,
			workerData: { revisionId: revision.revisionId, source: revision.source },
		});
		const contribution: RunningExtensionContribution = {
			sessionId: this.sessionId,
			extensionId: revision.extensionId,
			revisionId: revision.revisionId,
			sourceHash: revision.sourceHash,
			tools: [],
			prompts: [],
		};
		const running: RunningRevision = {
			revision,
			worker,
			pending: new Map(),
			buffered,
			contribution,
			terminated: false,
		};
		worker.on("message", (message: unknown) => {
			void this.handleWorkerMessage(running, message);
		});
		worker.on("error", (error) => {
			void this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_CRASHED", error.message));
		});
		worker.on("exit", (code) => {
			if (!running.terminated && code !== 0) {
				void this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_CRASHED", `Extension worker exited with code ${code}`));
			}
		});
		return running;
	}

	private activate(running: RunningRevision): Promise<void> {
		return new Promise((resolve, reject) => {
			const requestId = this.nextId();
			const timeout = setTimeout(() => {
				running.pending.delete(requestId);
				void this.terminateRunning(running, "EXTENSION_ACTIVATION_TIMEOUT");
				reject(new ExtensionRuntimeError("EXTENSION_ACTIVATION_TIMEOUT", "Extension activation exceeded its wall-clock timeout"));
			}, this.activationTimeoutMs);
			running.pending.set(requestId, {
				kind: "activation",
				requestId,
				resolve: (value) => {
					if (value !== undefined) {
						reject(new ExtensionRuntimeError("EXTENSION_INVALID_ACTIVATION_RESULT", "Extension activation must resolve undefined"));
						return;
					}
					resolve();
				},
				reject,
				timeout,
			});
			this.post(running, { type: "activate", requestId, revisionId: running.revision.revisionId, payload: {} });
		});
	}

	private async callTool(running: RunningRevision, toolName: string, args: JsonValue, signal: AbortSignal | undefined, toolCallId: string): Promise<JsonValue> {
		assertJsonValue(args, "tool args");
		const requestId = this.nextId();
		const controller = new AbortController();
		const abortFromCaller = (): void => controller.abort();
		signal?.addEventListener("abort", abortFromCaller, { once: true });
		try {
			return await new Promise<JsonValue>((resolve, reject) => {
				const timeout = setTimeout(() => {
					controller.abort();
					this.post(running, { type: "abortHandler", requestId, revisionId: running.revision.revisionId, payload: {} });
					setTimeout(() => {
						if (!running.pending.has(requestId)) return;
						running.pending.delete(requestId);
						this.running.delete(running.revision.extensionId);
						void this.terminateRunning(running, "EXTENSION_HANDLER_TIMEOUT");
						reject(new ExtensionRuntimeError("EXTENSION_HANDLER_TIMEOUT", "Extension tool handler exceeded its wall-clock timeout"));
					}, this.abortGraceMs);
				}, this.handlerTimeoutMs);
				running.pending.set(requestId, { kind: "handler", requestId, toolName, controller, resolve, reject, timeout });
				this.post(running, {
					type: "callTool",
					requestId,
					revisionId: running.revision.revisionId,
					payload: { toolName, args: structuredClone(args), toolCallId },
				});
			});
		} finally {
			signal?.removeEventListener("abort", abortFromCaller);
		}
	}

	private async handleWorkerMessage(running: RunningRevision, raw: unknown): Promise<void> {
		const message = raw as WorkerEnvelope;
		if (!isRecord(message) || typeof message.type !== "string" || typeof message.requestId !== "string") {
			await this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_PROTOCOL_ERROR", "Worker sent a malformed message"));
			return;
		}
		if (message.type === "registerTool") {
			this.bufferToolRegistration(running, message.manifest);
			return;
		}
		if (message.type === "registerPrompt") {
			this.bufferPromptRegistration(running, message.manifest);
			return;
		}
		if (message.type === "querySession" || message.type === "now" || message.type === "id") {
			await this.handleServiceRequest(running, message as unknown as WorkerEnvelope & { readonly type: string; readonly requestId: string });
			return;
		}
		if (message.type === "protocolError") {
			await this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_PROTOCOL_ERROR", workerErrorMessage(message)));
			return;
		}
		if (message.type !== "response") {
			await this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_PROTOCOL_ERROR", `Unknown worker message type: ${message.type}`));
			return;
		}
		const pending = running.pending.get(message.requestId);
		if (pending === undefined) {
			this.observeWorker({ code: "EXTENSION_WORKER_LATE_RESPONSE", message: `Late response for ${message.requestId}` });
			return;
		}
		running.pending.delete(message.requestId);
		clearTimeout(pending.timeout);
		if (message.ok !== true) {
			pending.reject(mapWorkerFailure(pending.kind, workerErrorMessage(message)));
			return;
		}
		if (pending.kind === "handler") {
			if (!isJsonValue(message.result)) {
				pending.reject(new ExtensionRuntimeError("EXTENSION_RESULT_NOT_JSON", "Extension handler returned a non-JSON value"));
				return;
			}
			pending.resolve(deepFreeze(structuredClone(message.result) as JsonValue));
			return;
		}
		pending.resolve(message.result);
	}

	private bufferToolRegistration(running: RunningRevision, manifest: unknown): void {
		if (!isToolDeclaration(manifest)) {
			void this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_PROTOCOL_ERROR", "Worker sent an invalid tool registration"));
			return;
		}
		running.buffered.tools.push({ manifest });
	}

	private bufferPromptRegistration(running: RunningRevision, manifest: unknown): void {
		if (!isPromptDeclaration(manifest)) {
			void this.failRunning(running, new ExtensionRuntimeError("EXTENSION_WORKER_PROTOCOL_ERROR", "Worker sent an invalid prompt registration"));
			return;
		}
		running.buffered.prompts.push(manifest);
	}

	private async handleServiceRequest(running: RunningRevision, message: WorkerEnvelope & { readonly type: string; readonly requestId: string }): Promise<void> {
		try {
			const result =
				message.type === "querySession"
					? await this.query(asJsonOrNull(message.payload))
					: message.type === "now"
						? this.clock()
						: `${this.sessionId}:${running.revision.extensionId}:${running.revision.revisionId}`;
			this.post(running, {
				type: "serviceResponse",
				requestId: message.requestId,
				revisionId: running.revision.revisionId,
				ok: true,
				result,
			});
		} catch (error) {
			this.post(running, {
				type: "serviceResponse",
				requestId: message.requestId,
				revisionId: running.revision.revisionId,
				ok: false,
				error: { message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	private assertManifestMatch(revision: ExtensionRevision, buffered: BufferedRegistrations): void {
		const expectedTools = (revision.manifest.tools ?? []).map((tool) => tool.name).toSorted();
		const actualTools = buffered.tools.map((tool) => tool.manifest.name).toSorted();
		const expectedPrompts = (revision.manifest.prompts ?? []).map((prompt) => prompt.id).toSorted();
		const actualPrompts = buffered.prompts.map((prompt) => prompt.id).toSorted();
		if (!sameSet(expectedTools, actualTools) || !sameSet(expectedPrompts, actualPrompts)) {
			throw new ExtensionRuntimeError("EXTENSION_MANIFEST_MISMATCH", "Extension registrations do not exactly match the reviewed manifest");
		}
		const active = this.running.get(revision.extensionId);
		if (active === undefined) return;
		const tools = buffered.tools.map((registration): RegisteredExtensionTool => ({
			name: registration.manifest.name,
			description: registration.manifest.description ?? "",
			inputSchema: registration.manifest.inputSchema ?? { type: "object", additionalProperties: true },
			execute: (args, context) => this.callTool(active, registration.manifest.name, args, context.signal, context.toolCallId),
		}));
		const prompts = buffered.prompts.map((prompt) => deepFreeze(structuredClone(prompt)) as ExtensionPromptDeclaration);
		replaceContribution(active, tools, prompts);
	}

	private async stopRunning(running: RunningRevision): Promise<void> {
		for (const pending of running.pending.values()) {
			if (pending.kind === "handler") {
				pending.controller.abort();
				this.post(running, { type: "abortHandler", requestId: pending.requestId, revisionId: running.revision.revisionId, payload: {} });
			}
		}
		try {
			await withTimeout(this.waitForHandlers(running), this.disposeTimeoutMs, () => {
				throw new ExtensionRuntimeError("EXTENSION_DISPOSE_TIMEOUT", "Extension disposal exceeded its bounded quiescence timeout");
			});
		} catch (error) {
			await this.terminateRunning(running, "EXTENSION_DISPOSE_TIMEOUT");
			throw error;
		}
		await this.terminateRunning(running, "EXTENSION_DISPOSE_TIMEOUT");
	}

	private async waitForHandlers(running: RunningRevision): Promise<void> {
		while ([...running.pending.values()].some((pending) => pending.kind === "handler")) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	private async failRunning(running: RunningRevision, error: ExtensionRuntimeError): Promise<void> {
		await this.terminateRunning(running, error.code);
		this.running.delete(running.revision.extensionId);
		await this.emitFailure(running.revision, error);
	}

	private async terminateRunning(running: RunningRevision, code: ExtensionErrorCode): Promise<void> {
		if (running.terminated) return;
		running.terminated = true;
		this.running.delete(running.revision.extensionId);
		for (const pending of running.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new ExtensionRuntimeError(code, "Extension worker terminated"));
		}
		running.pending.clear();
		await running.worker.terminate();
		replaceContribution(running, [], []);
	}

	private post(running: RunningRevision, message: JsonValue): void {
		running.worker.postMessage(message);
	}

	private assertSession(sessionId: string): void {
		if (sessionId !== this.sessionId) {
			throw new ExtensionRuntimeError("EXTENSION_SESSION_MISMATCH", "Extension lifecycle request targets a different session");
		}
	}

	private findRevision(extensionId: string, revisionId: string): ExtensionRevision {
		const revision = this.definitions.get(extensionId)?.revisions.find((candidate) => candidate.revisionId === revisionId);
		if (revision === undefined) throw new ExtensionRuntimeError("EXTENSION_NOT_FOUND", "Extension revision was not found");
		return revision;
	}

	private replaceRevision(revision: ExtensionRevision): void {
		const definition = this.definitions.get(revision.extensionId);
		if (definition === undefined) throw new ExtensionRuntimeError("EXTENSION_NOT_FOUND", "Extension definition was not found");
		this.definitions.set(revision.extensionId, {
			...definition,
			revisions: definition.revisions.map((candidate) => (candidate.revisionId === revision.revisionId ? revision : candidate)),
		});
	}

	private markActive(extensionId: string, revisionId: string | undefined): void {
		const definition = this.definitions.get(extensionId);
		if (definition === undefined) return;
		this.definitions.set(extensionId, { ...definition, activeRevisionId: revisionId });
	}

	private async emitFailure(revision: ExtensionRevision, error: ExtensionRuntimeError): Promise<void> {
		await this.emit({
			type: "extension/failed",
			sessionId: this.sessionId,
			extensionId: revision.extensionId,
			revisionId: revision.revisionId,
			sourceHash: revision.sourceHash,
			status: "failed",
			code: error.code,
			message: error.message,
			metadata: receiptMetadata(revision),
		});
	}

	private async emit(receipt: ExtensionReceipt): Promise<void> {
		await this.receiptSink(receipt);
	}
}

function assertExtensionId(extensionId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(extensionId)) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Extension id must be a stable local identifier");
	}
}

function validateManifest(manifest: ExtensionContributionManifest): void {
	if ((manifest.tools?.length ?? 0) > MAX_EXTENSION_CONTRIBUTIONS || (manifest.prompts?.length ?? 0) > MAX_EXTENSION_CONTRIBUTIONS) {
		throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", `Extension manifest exceeds ${MAX_EXTENSION_CONTRIBUTIONS} contributions per kind`);
	}
	const toolNames = new Set<string>();
	for (const tool of manifest.tools ?? []) {
		if (!isToolDeclaration(tool)) throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Invalid tool declaration");
		if (toolNames.has(tool.name)) throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Duplicate tool declaration");
		toolNames.add(tool.name);
	}
	const promptIds = new Set<string>();
	for (const prompt of manifest.prompts ?? []) {
		if (!isPromptDeclaration(prompt)) throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Invalid prompt declaration");
		if (promptIds.has(prompt.id)) throw new ExtensionRuntimeError("EXTENSION_SOURCE_SYNTAX", "Duplicate prompt declaration");
		promptIds.add(prompt.id);
	}
}

function isToolDeclaration(value: unknown): value is ExtensionToolDeclaration {
	return isRecord(value) &&
		typeof value.name === "string" &&
		/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.name) &&
		(value.description === undefined || (typeof value.description === "string" && value.description.length <= 4_096)) &&
		(value.inputSchema === undefined || isJsonValue(value.inputSchema));
}

function isPromptDeclaration(value: unknown): value is ExtensionPromptDeclaration {
	return isRecord(value) &&
		typeof value.id === "string" &&
		/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value.id) &&
		typeof value.text === "string" &&
		Buffer.byteLength(value.text) <= MAX_EXTENSION_PROMPT_BYTES;
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
	if (!isRecord(value)) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	return Object.values(value).every((item) => isJsonValue(item, seen));
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
	if (!isJsonValue(value)) throw new ExtensionRuntimeError("EXTENSION_RESULT_NOT_JSON", `${label} must be JSON-serializable`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonOrNull(value: unknown): JsonValue {
	return isJsonValue(value) ? value : null;
}

function deepFreeze<T extends JsonValue | ExtensionPromptDeclaration | ExtensionContributionManifest>(value: T): T {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
		return Object.freeze(value) as T;
	}
	if (isRecord(value)) {
		for (const item of Object.values(value)) {
			if (isJsonValue(item) || isPromptDeclaration(item) || isRecord(item)) deepFreeze(item as JsonValue);
		}
		return Object.freeze(value) as T;
	}
	return value;
}

function cloneManifest(manifest: ExtensionContributionManifest): ExtensionContributionManifest {
	return deepFreeze(structuredClone(manifest) as ExtensionContributionManifest);
}

function freezeRevision(revision: ExtensionRevision): ExtensionRevision {
	return Object.freeze({
		...revision,
		manifest: cloneManifest(revision.manifest),
	});
}

function cloneDefinition(definition: ExtensionDefinition): ExtensionDefinition {
	return Object.freeze({
		extensionId: definition.extensionId,
		activeRevisionId: definition.activeRevisionId,
		revisions: definition.revisions.map((revision) => ({ ...revision, source: "[durable in assistant tool-call history]" })),
	});
}

function receiptMetadata(revision: ExtensionRevision): JsonValue {
	return {
		purpose: revision.purpose,
		metadata: revision.metadata ?? null,
		approved: revision.approved,
		approvedAt: revision.approvedAt ?? null,
	};
}

function replaceContribution(
	running: RunningRevision,
	tools: readonly RegisteredExtensionTool[],
	prompts: readonly ExtensionPromptDeclaration[],
): void {
	const next: RunningExtensionContribution = {
		sessionId: running.contribution.sessionId,
		extensionId: running.contribution.extensionId,
		revisionId: running.contribution.revisionId,
		sourceHash: running.contribution.sourceHash,
		tools,
		prompts,
	};
	Object.assign(running.contribution, next);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workerErrorMessage(message: WorkerEnvelope): string {
	if (isRecord(message.error) && typeof message.error.message === "string") return message.error.message;
	return "Extension worker request failed";
}

function mapWorkerFailure(kind: PendingCall["kind"], message: string): ExtensionRuntimeError {
	if (/Script execution timed out|syntax|Unexpected token/i.test(message)) {
		return new ExtensionRuntimeError("EXTENSION_SOURCE_EVALUATION_FAILED", message);
	}
	return kind === "activation"
		? new ExtensionRuntimeError("EXTENSION_ACTIVATION_FAILED", message)
		: new ExtensionRuntimeError("EXTENSION_HANDLER_FAILED", message);
}

function toExtensionError(error: unknown): ExtensionRuntimeError {
	return error instanceof ExtensionRuntimeError
		? error
		: new ExtensionRuntimeError("EXTENSION_ACTIVATION_FAILED", error instanceof Error ? error.message : String(error));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => never): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => {
					try {
						onTimeout();
					} catch (error) {
						reject(error);
					}
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
