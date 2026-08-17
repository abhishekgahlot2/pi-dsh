import { uuidv7 } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeDurableExecutionEnv } from "../src/env.ts";
import { DurableJsonlSessionStorage } from "../src/persistence.ts";
import { parseHeader } from "../vendor/pi/harness/session/jsonl/codec.ts";
import type { JsonlSessionMetadata, JsonlV4Header } from "../vendor/pi/harness/session/jsonl.ts";
import { Session } from "../vendor/pi/harness/session/session.ts";
import type { ForkOptions, SessionCreateOptions, SessionRepo } from "../vendor/pi/harness/session/types.ts";
import { SessionError } from "../vendor/pi/harness/session/types.ts";
import { createSessionBackendConformance } from "../vendor/pi/harness/session/testing/conformance.ts";

class ConformanceRepository implements SessionRepo<JsonlSessionMetadata, SessionCreateOptions> {
	private readonly storageById = new Map<string, DurableJsonlSessionStorage>();

	constructor(
		private readonly env: NodeDurableExecutionEnv,
		private readonly root: string,
	) {}

	async create(options: SessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? uuidv7();
		if ((await this.list()).some((metadata) => metadata.id === id)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}
		const header = this.header(id, options.parentSessionId);
		return new Session(await this.createStorage(header));
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		await this.closeStorage(metadata.id);
		const exists = await this.env.exists(metadata.path);
		if (!exists.ok) throw exists.error;
		if (!exists.value) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		const storage = await DurableJsonlSessionStorage.load(this.env, metadata.path);
		this.storageById.set(metadata.id, storage);
		return new Session(storage);
	}

	async list(): Promise<JsonlSessionMetadata[]> {
		const exists = await this.env.exists(this.root);
		if (!exists.ok || !exists.value) return [];
		const listed = await this.env.listDir(this.root);
		if (!listed.ok) throw listed.error;
		const metadata: JsonlSessionMetadata[] = [];
		for (const entry of listed.value.filter((candidate) => candidate.kind === "file" && candidate.name.endsWith(".jsonl"))) {
			const lines = await this.env.readTextLines(entry.path, { maxLines: 1 });
			if (!lines.ok || !lines.value[0]) continue;
			const parsed = parseHeader(lines.value[0]);
			if (!parsed.ok) continue;
			metadata.push({ ...parsed.value, path: entry.path, modifiedAt: entry.mtimeMs, sourceFormat: 4 });
		}
		return metadata.toSorted((left, right) => right.modifiedAt - left.modifiedAt);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		await this.closeStorage(metadata.id);
		const removed = await this.env.remove(metadata.path, { force: true });
		if (!removed.ok) throw removed.error;
	}

	async fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & SessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const sourceStorage = this.storageById.get(source.id) ?? (await DurableJsonlSessionStorage.load(this.env, source.path));
		const temporarySource = !this.storageById.has(source.id);
		const id = options.id ?? uuidv7();
		try {
			const storage = await sourceStorage.fork(
				await this.pathFor(id),
				this.header(id, options.parentSessionId ?? source.id),
				options,
			);
			this.storageById.set(id, storage);
			return new Session(storage);
		} finally {
			if (temporarySource) await sourceStorage.close();
		}
	}

	async close(): Promise<void> {
		await Promise.all([...this.storageById.values()].map((storage) => storage.close()));
		this.storageById.clear();
	}

	private async createStorage(header: JsonlV4Header): Promise<DurableJsonlSessionStorage> {
		const created = await this.env.createDir(this.root, { recursive: true });
		if (!created.ok) throw created.error;
		const storage = await DurableJsonlSessionStorage.create(this.env, await this.pathFor(header.id), header);
		this.storageById.set(header.id, storage);
		return storage;
	}

	private header(id: string, parentSessionId?: string): JsonlV4Header {
		return {
			kind: "header",
			version: 4,
			id,
			createdAt: Date.now(),
			cwd: this.root,
			...(parentSessionId === undefined ? {} : { parentSessionId }),
		};
	}

	private async pathFor(id: string): Promise<string> {
		const result = await this.env.joinPath([this.root, `${id}.jsonl`]);
		if (!result.ok) throw result.error;
		return result.value;
	}

	private async closeStorage(id: string): Promise<void> {
		const storage = this.storageById.get(id);
		if (storage === undefined) return;
		await storage.close();
		this.storageById.delete(id);
	}
}

const cases = createSessionBackendConformance(async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsh-conformance-"));
	const repository = new ConformanceRepository(new NodeDurableExecutionEnv({ cwd: root }), join(root, "sessions"));
	return {
		repository,
		async [Symbol.asyncDispose]() {
			await repository.close();
			await rm(root, { recursive: true, force: true });
		},
	};
});

describe("durable Pi v4 backend conformance", () => {
	it("vendors the complete 30-case suite", () => {
		expect(cases).toHaveLength(30);
	});

	for (const testCase of cases) {
		it(`${testCase.group}: ${testCase.name}`, async () => testCase.run());
	}
});
