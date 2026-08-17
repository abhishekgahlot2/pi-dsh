import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeDurableExecutionEnv } from "../src/env.ts";
import { DurableJsonlSessionStorage, sessionLockPath } from "../src/persistence.ts";
import type { DurableJsonlFileSystem } from "../src/env.ts";
import { err, FileError, type Result } from "../vendor/pi/harness/types.ts";
import type { JsonlV4Header } from "../vendor/pi/harness/session/jsonl.ts";

class InstrumentedFs extends NodeDurableExecutionEnv {
	readonly events: string[] = [];
	failNextSyncFile = false;

	override async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		this.events.push(`append:${path}`);
		return super.appendFile(path, content);
	}

	override async syncFile(path: string): Promise<Result<void, FileError>> {
		this.events.push(`syncFile:${path}`);
		if (this.failNextSyncFile) {
			this.failNextSyncFile = false;
			return err(new FileError("unknown", "injected sync failure", path));
		}
		return super.syncFile(path);
	}

	override async syncDir(path: string): Promise<Result<void, FileError>> {
		this.events.push(`syncDir:${path}`);
		return super.syncDir(path);
	}

	override async truncateFile(path: string, size: number): Promise<Result<void, FileError>> {
		this.events.push(`truncate:${path}:${size}`);
		return super.truncateFile(path, size);
	}

	override async linkFile(sourcePath: string, destinationPath: string): Promise<Result<void, FileError>> {
		this.events.push(`link:${sourcePath}:${destinationPath}`);
		return super.linkFile(sourcePath, destinationPath);
	}
}

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsh-persistence-"));
	tempRoots.push(root);
	return root;
}

function header(id = "session-a"): JsonlV4Header {
	return {
		kind: "header",
		version: 4,
		id,
		createdAt: 1_800_000_000_000,
		cwd: "/tmp/project",
	};
}

async function createStorage(fs: DurableJsonlFileSystem, path: string): Promise<DurableJsonlSessionStorage> {
	return DurableJsonlSessionStorage.create(fs, path, header());
}

describe("DurableJsonlSessionStorage", () => {
	it("fsyncs an append before resolving", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });
		const storage = await createStorage(fs, path);
		fs.events.length = 0;

		await storage.setName("durable");

		expect(fs.events).toEqual([
			`append:${path}`,
			`syncFile:${path}`,
		]);
		expect(await storage.getName()).toBe("durable");
		await storage.close();
	});

	it("rolls back an append when sync fails and leaves state unchanged", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });
		const storage = await createStorage(fs, path);
		const sizeBefore = (await stat(path)).size;
		fs.events.length = 0;
		fs.failNextSyncFile = true;

		await expect(storage.setName("lost")).rejects.toThrow("Failed to append session");

		expect((await stat(path)).size).toBe(sizeBefore);
		expect(await storage.getName()).toBeUndefined();
		expect(fs.events).toEqual([
			`append:${path}`,
			`syncFile:${path}`,
			`truncate:${path}:${sizeBefore}`,
			`syncFile:${path}`,
		]);
		await storage.close();
	});

	it("publishes new sessions without clobbering an existing destination", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });
		await writeFile(path, "already here\n");

		await expect(DurableJsonlSessionStorage.create(fs, path, header())).rejects.toThrow("Session already exists");

		expect(await readFile(path, "utf8")).toBe("already here\n");
	});

	it("syncs the parent directory when publishing a new session", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });

		const storage = await createStorage(fs, path);

		expect(fs.events.some((event) => event === `syncDir:${root}`)).toBe(true);
		await storage.close();
	});

	it("truncates and syncs a torn final syntax line on load", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });
		const storage = await createStorage(fs, path);
		await storage.setName("committed");
		await storage.close();
		const committed = await readFile(path, "utf8");
		await writeFile(path, `${committed}{`);
		fs.events.length = 0;

		const loaded = await DurableJsonlSessionStorage.load(fs, path);

		expect(await readFile(path, "utf8")).toBe(committed);
		expect(await loaded.getName()).toBe("committed");
		expect(fs.events).toContain(`truncate:${path}:${Buffer.byteLength(committed)}`);
		expect(fs.events).toContain(`syncFile:${path}`);
		await loaded.close();
	});

	it("refuses interior corruption without changing bytes", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });
		const storage = await createStorage(fs, path);
		await storage.setName("first");
		await storage.setName("second");
		await storage.close();
		const lines = (await readFile(path, "utf8")).split("\n");
		lines[1] = "{";
		const corrupt = lines.join("\n");
		await writeFile(path, corrupt);

		await expect(DurableJsonlSessionStorage.load(fs, path)).rejects.toThrow("is not valid JSON");

		expect(await readFile(path, "utf8")).toBe(corrupt);
	});

	it("rejects a second live writer and removes only the owned lock", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const firstFs = new InstrumentedFs({ cwd: root });
		const secondFs = new InstrumentedFs({ cwd: root });
		const first = await createStorage(firstFs, path);

		await expect(DurableJsonlSessionStorage.load(secondFs, path)).rejects.toThrow("live writer");

		expect(await readFile(sessionLockPath(path), "utf8")).toContain(String(process.pid));
		await first.close();
		await expect(readFile(sessionLockPath(path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("replaces a stale lock", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const fs = new InstrumentedFs({ cwd: root });
		const storage = await createStorage(fs, path);
		await storage.close();
		await writeFile(sessionLockPath(path), `${JSON.stringify({ pid: 9_999_999, processStartTime: 1, token: "stale" })}\n`);

		const loaded = await DurableJsonlSessionStorage.load(fs, path);

		expect(await readFile(sessionLockPath(path), "utf8")).not.toContain("stale");
		await loaded.close();
	});

	it("serializes exclusive check-and-commit work with ordinary appends", async () => {
		const root = await tempRoot();
		const path = join(root, "session.jsonl");
		const storage = await createStorage(new InstrumentedFs({ cwd: root }), path);
		let releaseExclusive!: () => void;
		const paused = new Promise<void>((resolve) => {
			releaseExclusive = resolve;
		});
		const order: string[] = [];
		const transaction = storage.runExclusive(async () => {
			order.push("check");
			await paused;
			await storage.appendEntry({ type: "custom", id: "inside", customType: "test" }, "main");
			order.push("commit");
		});
		const outside = (async () => {
			await storage.appendEntry({ type: "custom", id: "outside", customType: "test" }, "main");
			order.push("outside");
		})();

		await Promise.resolve();
		releaseExclusive();
		await Promise.all([transaction, outside]);

		expect(order).toEqual(["check", "commit", "outside"]);
		await storage.close();
	});
});
