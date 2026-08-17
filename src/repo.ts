import { uuidv7 } from "@earendil-works/pi-ai";
import { dirname } from "node:path";
import { parseHeader } from "../vendor/pi/harness/session/jsonl/codec.ts";
import type { ForkOptions, JsonValue } from "../vendor/pi/harness/session/types.ts";
import type { JsonlSessionMetadata, JsonlV4Header } from "../vendor/pi/harness/session/jsonl.ts";
import { assertJsonSerializable, Session, SessionError } from "../vendor/pi/harness/session/index.ts";
import type { DurableJsonlFileSystem } from "./env.ts";
import { DurableJsonlSessionStorage } from "./persistence.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }, message: string): T {
	if (!result.ok) throw new SessionError("storage", message, result.error);
	return result.value;
}

function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError("invalid_payload", `Invalid session id: ${id}`);
	}
}

export interface DurableSessionCreateOptions {
	id?: string;
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, JsonValue>;
}

export type DurableSessionForkOptions = ForkOptions & {
	id?: string;
	cwd?: string;
	parentSessionId?: string;
	metadata?: Record<string, JsonValue>;
};

export class DurableSessionHandle {
	readonly session: Session<JsonlSessionMetadata>;

	constructor(readonly storage: DurableJsonlSessionStorage) {
		this.session = new Session(storage);
	}

	drain(): Promise<void> {
		return this.storage.drain();
	}

	close(): Promise<void> {
		return this.storage.close();
	}
}

/**
 * Small adapter over Pi's v4 Session/SessionStorage contracts. Durability and ownership
 * enforce durable ownership while Pi's log vocabulary remains unchanged.
 */
export class DurableSessionRepository {
	constructor(
		private readonly fs: DurableJsonlFileSystem,
		private readonly sessionsRoot: string,
	) {}

	async create(options: DurableSessionCreateOptions): Promise<DurableSessionHandle> {
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const root = unwrap(await this.fs.absolutePath(this.sessionsRoot), "Failed to resolve sessions root");
		unwrap(await this.fs.createDir(root, { recursive: true }), `Failed to create sessions root ${root}`);
		unwrap(await this.fs.syncDir(root), `Failed to sync sessions root ${root}`);
		unwrap(await this.fs.syncDir(dirname(root)), `Failed to sync sessions parent ${dirname(root)}`);
		const path = unwrap(await this.fs.joinPath([root, `${id}.jsonl`]), `Failed to resolve session path ${id}`);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt: Date.now(),
			cwd: options.cwd,
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			...(options.metadata === undefined ? {} : { metadata: options.metadata }),
		};
		return new DurableSessionHandle(await DurableJsonlSessionStorage.create(this.fs, path, header));
	}

	async open(id: string): Promise<DurableSessionHandle> {
		validateSessionId(id);
		const path = await this.pathFor(id);
		const handle = new DurableSessionHandle(await DurableJsonlSessionStorage.load(this.fs, path));
		const metadata = await handle.session.getMetadata();
		if (metadata.id !== id) {
			await handle.close();
			throw new SessionError("invalid_entry", `Session id does not match header: ${id}`);
		}
		return handle;
	}

	async list(): Promise<JsonlSessionMetadata[]> {
		const root = unwrap(await this.fs.absolutePath(this.sessionsRoot), "Failed to resolve sessions root");
		if (!unwrap(await this.fs.exists(root), `Failed to check sessions root ${root}`)) return [];
		const entries = unwrap(await this.fs.listDir(root), `Failed to list sessions root ${root}`)
			.filter((entry) => entry.kind === "file" && entry.name.endsWith(".jsonl"));
		const metadata: JsonlSessionMetadata[] = [];
		for (const entry of entries) {
			const [line] = unwrap(await this.fs.readTextLines(entry.path, { maxLines: 1 }), `Failed to read ${entry.path}`);
			if (!line) continue;
			const parsed = parseHeader(line);
			if (!parsed.ok) continue;
			metadata.push({
				...parsed.value,
				path: entry.path,
				modifiedAt: entry.mtimeMs,
				sourceFormat: 4,
			} satisfies JsonlSessionMetadata);
		}
		return metadata.toSorted((left, right) => right.modifiedAt - left.modifiedAt);
	}

	async fork(source: DurableSessionHandle, options: DurableSessionForkOptions = {}): Promise<DurableSessionHandle> {
		if ((await source.storage.findOpenOperations("main", { limit: 1 })).length > 0) {
			throw new SessionError("storage", "Cannot fork a session with an open operation");
		}
		const sourceMetadata = await source.storage.getMetadata();
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const root = unwrap(await this.fs.absolutePath(this.sessionsRoot), "Failed to resolve sessions root");
		unwrap(await this.fs.createDir(root, { recursive: true }), `Failed to create sessions root ${root}`);
		unwrap(await this.fs.syncDir(root), `Failed to sync sessions root ${root}`);
		const path = unwrap(await this.fs.joinPath([root, `${id}.jsonl`]), `Failed to resolve fork path ${id}`);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt: Date.now(),
			cwd: options.cwd ?? sourceMetadata.cwd,
			parentSessionId: options.parentSessionId ?? sourceMetadata.id,
			...(options.metadata === undefined ? {} : { metadata: options.metadata }),
		};
		return new DurableSessionHandle(await source.storage.fork(path, header, options));
	}

	private async pathFor(id: string): Promise<string> {
		const root = unwrap(await this.fs.absolutePath(this.sessionsRoot), "Failed to resolve sessions root");
		return unwrap(await this.fs.joinPath([root, `${id}.jsonl`]), `Failed to resolve session path ${id}`);
	}
}
