import { AsyncLocalStorage } from "node:async_hooks";

// Durable Pi v4 storage implements write-sync-ack ordering and single-writer ownership.
import { dirname } from "node:path";
import { encodeHeader, encodeMutation, metadataFromHeader, parseHeader, parseMutation } from "../vendor/pi/harness/session/jsonl/codec.ts";
import { invalidFile } from "../vendor/pi/harness/session/jsonl/errors.ts";
import type { JsonlSessionMetadata, JsonlV4Header } from "../vendor/pi/harness/session/jsonl.ts";
import { SessionState, type SessionMutation } from "../vendor/pi/harness/session/state.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	SessionError,
	type SessionStats,
	type SessionStorage,
	type ForkOptions,
} from "../vendor/pi/harness/session/types.ts";
import { type FileError, type Result } from "../vendor/pi/harness/types.ts";
import type { DurableJsonlFileSystem } from "./env.ts";

type LockPayload = {
	pid: number;
	processStartTime: number;
	token: string;
};

const PROCESS_START_TIME = Date.now();

function unwrap<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) throw new SessionError("storage", message, result.error);
	return result.value;
}

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function pidIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

function lockPathFor(path: string): string {
	return `${path}.lock`;
}

function parseLock(content: string): LockPayload | undefined {
	try {
		const value = JSON.parse(content) as Partial<LockPayload>;
		if (
			Number.isSafeInteger(value.pid) &&
			Number.isSafeInteger(value.processStartTime) &&
			typeof value.token === "string"
		) {
			return value as LockPayload;
		}
	} catch {
		// Invalid lock payloads are treated as stale and replaceable.
	}
	return undefined;
}

async function acquireLock(fs: DurableJsonlFileSystem, path: string): Promise<LockPayload> {
	const lockPath = lockPathFor(path);
	const payload: LockPayload = {
		pid: process.pid,
		processStartTime: PROCESS_START_TIME,
		token: `${process.pid}:${PROCESS_START_TIME}:${Math.random().toString(36).slice(2)}`,
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const tempPath = `${lockPath}.${payload.token}.tmp`;
		unwrap(await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`), `Failed to stage writer lock ${lockPath}`);
		try {
			const linked = await fs.linkFile(tempPath, lockPath);
			if (linked.ok) {
				unwrap(await fs.syncFile(lockPath), `Failed to sync writer lock ${lockPath}`);
				unwrap(await fs.remove(tempPath, { force: true }), `Failed to remove staged writer lock ${tempPath}`);
				unwrap(await fs.syncDir(dirname(lockPath)), `Failed to sync writer lock directory ${dirname(lockPath)}`);
				return payload;
			}
			const existing = unwrap(await fs.readTextFile(lockPath), `Failed to read writer lock ${lockPath}`);
			const lock = parseLock(existing);
			const lockIsThisProcess = lock?.pid === process.pid;
			const stale =
				lock === undefined ||
				!pidIsAlive(lock.pid) ||
				(lockIsThisProcess && lock.processStartTime !== PROCESS_START_TIME);
			if (!stale) {
				throw new SessionError("storage", `Session already has a live writer: ${path}`);
			}
			unwrap(await fs.remove(lockPath, { force: true }), `Failed to remove stale writer lock ${lockPath}`);
			unwrap(await fs.syncDir(dirname(lockPath)), `Failed to sync stale writer lock removal ${dirname(lockPath)}`);
		} finally {
			await fs.remove(tempPath, { force: true });
		}
	}
	throw new SessionError("storage", `Failed to acquire writer lock ${lockPath}`);
}

async function releaseLock(fs: DurableJsonlFileSystem, path: string, payload: LockPayload): Promise<void> {
	const lockPath = lockPathFor(path);
	const existingResult = await fs.readTextFile(lockPath);
	if (!existingResult.ok) return;
	const existing = parseLock(existingResult.value);
	if (existing?.token !== payload.token) return;
	unwrap(await fs.remove(lockPath, { force: true }), `Failed to remove writer lock ${lockPath}`);
	unwrap(await fs.syncDir(dirname(lockPath)), `Failed to sync writer lock removal ${dirname(lockPath)}`);
}

async function publishFileAtomically(
	fs: DurableJsonlFileSystem,
	destinationPath: string,
	content: string,
): Promise<void> {
	const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		unwrap(await fs.writeFile(tempPath, content), `Failed to stage session ${destinationPath}`);
		unwrap(await fs.syncFile(tempPath), `Failed to sync staged session ${tempPath}`);
		unwrap(await fs.linkFile(tempPath, destinationPath), `Session already exists: ${destinationPath}`);
		unwrap(await fs.remove(tempPath, { force: true }), `Failed to remove staged session ${tempPath}`);
		unwrap(await fs.syncDir(dirname(destinationPath)), `Failed to sync session directory ${dirname(destinationPath)}`);
	} catch (error) {
		await fs.remove(tempPath, { force: true });
		throw error;
	}
}

function parseCommittedContent(path: string, content: string): { header: JsonlV4Header; mutations: SessionMutation[]; repairOffset?: number } {
	const physicalLines = content.split("\n");
	if (physicalLines.at(-1) === "") physicalLines.pop();
	if (physicalLines.length === 0 || !physicalLines[0]) {
		throw invalidFile(path, 1, new Error("is missing a header"));
	}
	const headerResult = parseHeader(physicalLines[0]);
	if (!headerResult.ok) throw invalidFile(path, 1, headerResult.error);

	const mutations: SessionMutation[] = [];
	let offset = bytes(`${physicalLines[0]}\n`);
	for (let index = 1; index < physicalLines.length; index++) {
		const line = physicalLines[index]!;
		const lineStart = offset;
		offset += bytes(`${line}\n`);
		const mutationResult = parseMutation(line);
		if (!mutationResult.ok) {
			const isFinalLine = index === physicalLines.length - 1;
			if (isFinalLine && mutationResult.error.kind === "syntax") {
				return { header: headerResult.value, mutations, repairOffset: lineStart };
			}
			throw invalidFile(path, index + 1, mutationResult.error);
		}
		mutations.push(mutationResult.value);
	}

	if (!content.endsWith("\n")) {
		const finalLineStart = content.lastIndexOf("\n") + 1;
		if (finalLineStart <= 0) throw invalidFile(path, 1, new Error("header is not newline terminated"));
		return { header: headerResult.value, mutations: mutations.slice(0, -1), repairOffset: finalLineStart };
	}
	return { header: headerResult.value, mutations };
}

function applyMutations(path: string, state: SessionState, mutations: SessionMutation[]): void {
	for (let index = 0; index < mutations.length; index++) {
		try {
			state.applyMutation(mutations[index]!);
		} catch (error) {
			if (error instanceof SessionError && error.code === "invalid_entry") {
				throw invalidFile(path, index + 2, error);
			}
			throw error;
		}
	}
}

export class DurableJsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: DurableJsonlFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private readonly state = new SessionState();
	private readonly lock: LockPayload;
	private readonly exclusiveContext = new AsyncLocalStorage<boolean>();
	private tail: Promise<void> = Promise.resolve();
	private closed = false;

	private constructor(fs: DurableJsonlFileSystem, metadata: JsonlSessionMetadata, lock: LockPayload) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
		this.lock = lock;
	}

	static async create(
		fs: DurableJsonlFileSystem,
		path: string,
		header: JsonlV4Header,
	): Promise<DurableJsonlSessionStorage> {
		const lock = await acquireLock(fs, path);
		try {
			await publishFileAtomically(fs, path, encodeHeader(header));
			const fileInfo = unwrap(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
			return new DurableJsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs), lock);
		} catch (error) {
			await releaseLock(fs, path, lock);
			throw error;
		}
	}

	static async load(fs: DurableJsonlFileSystem, path: string): Promise<DurableJsonlSessionStorage> {
		const lock = await acquireLock(fs, path);
		try {
			const content = unwrap(await fs.readTextFile(path), `Failed to read session ${path}`);
			const parsed = parseCommittedContent(path, content);
			if (parsed.repairOffset !== undefined) {
				unwrap(await fs.truncateFile(path, parsed.repairOffset), `Failed to truncate torn session tail ${path}`);
				unwrap(await fs.syncFile(path), `Failed to sync torn-tail repair ${path}`);
				return await this.loadWithExistingLock(fs, path, lock);
			}
			const fileInfo = unwrap(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
			const storage = new DurableJsonlSessionStorage(fs, metadataFromHeader(parsed.header, path, fileInfo.mtimeMs), lock);
			applyMutations(path, storage.state, parsed.mutations);
			return storage;
		} catch (error) {
			await releaseLock(fs, path, lock);
			throw error;
		}
	}

	private static async loadWithExistingLock(
		fs: DurableJsonlFileSystem,
		path: string,
		lock: LockPayload,
	): Promise<DurableJsonlSessionStorage> {
		const content = unwrap(await fs.readTextFile(path), `Failed to read repaired session ${path}`);
		const parsed = parseCommittedContent(path, content);
		if (parsed.repairOffset !== undefined) {
			throw new SessionError("storage", `Session still has a torn tail after repair: ${path}`);
		}
		const fileInfo = unwrap(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new DurableJsonlSessionStorage(fs, metadataFromHeader(parsed.header, path, fileInfo.mtimeMs), lock);
		applyMutations(path, storage.state, parsed.mutations);
		return storage;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.drain();
		this.closed = true;
		await releaseLock(this.fs, this.metadata.path, this.lock);
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<DurableJsonlSessionStorage> {
		const target = await DurableJsonlSessionStorage.create(this.fs, path, header);
		try {
			for (const mutation of this.state.createForkMutations(options)) {
				await target.appendMutation(mutation);
				target.state.applyMutation(mutation);
			}
			return target;
		} catch (error) {
			await target.close();
			await this.fs.remove(path, { force: true });
			throw error;
		}
	}

	/** Serialize a read-check-write transaction with ordinary mutations. */
	runExclusive<T>(job: () => Promise<T>): Promise<T> {
		return this.enqueue(() => this.exclusiveContext.run(true, job));
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			await this.appendMutation(mutation);
			this.state.applyMutation(mutation);
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			await this.appendMutation(mutation);
			this.state.applyMutation(mutation);
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: SessionMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.state.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
			const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
			if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
				throw new SessionError("storage", `Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`);
			}
			const record = {
				...structuredClone(newRecord),
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TRecord;
			const mutation: SessionMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.state.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
			await this.appendMutation(mutation);
			this.state.applyMutation(mutation);
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(id);
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "label", targetId: id, label };
			await this.appendMutation(mutation);
			this.state.applyMutation(mutation);
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new SessionError("storage", `Session storage is closed: ${this.metadata.path}`));
		if (this.exclusiveContext.getStore() === true) return operation();
		const preceding = this.tail;
		const gate = Promise.withResolvers<void>();
		this.tail = gate.promise;
		await preceding;
		try {
			return await operation();
		} finally {
			gate.resolve();
		}
	}

	private async appendMutation(mutation: SessionMutation): Promise<void> {
		const previousSize = unwrap(await this.fs.fileInfo(this.metadata.path), `Failed to stat session ${this.metadata.path}`).size;
		const encoded = encodeMutation(mutation);
		const appendResult = await this.fs.appendFile(this.metadata.path, encoded);
		const syncResult = appendResult.ok ? await this.fs.syncFile(this.metadata.path) : appendResult;
		if (syncResult.ok) return;

		const rollbackError = await this.rollbackAppend(previousSize);
		if (rollbackError) {
			throw new AggregateError([syncResult.error, rollbackError], `Failed to append session ${this.metadata.path} and rollback failed`);
		}
		throw new SessionError("storage", `Failed to append session ${this.metadata.path}`, syncResult.error);
	}

	private async rollbackAppend(previousSize: number): Promise<Error | undefined> {
		const truncateResult = await this.fs.truncateFile(this.metadata.path, previousSize);
		const syncResult = truncateResult.ok ? await this.fs.syncFile(this.metadata.path) : truncateResult;
		return syncResult.ok ? undefined : syncResult.error;
	}
}

export function sessionLockPath(path: string): string {
	return lockPathFor(path);
}
