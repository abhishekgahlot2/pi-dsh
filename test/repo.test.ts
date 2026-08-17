import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeDurableExecutionEnv } from "../src/env.ts";
import { DurableSessionRepository } from "../src/repo.ts";

describe("DurableSessionRepository", () => {
	it("creates, lists, closes, and reopens one Pi v4 session", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsh-repo-"));
		const repository = new DurableSessionRepository(new NodeDurableExecutionEnv({ cwd: root }), join(root, "sessions"));
		const created = await repository.create({ id: "session-1", cwd: root });
		await created.session.appendCustomEntry("test", { value: 1 });

		const listed = await repository.list();
		expect(listed.map((entry) => entry.id)).toEqual(["session-1"]);
		await created.close();

		const reopened = await repository.open("session-1");
		expect((await reopened.session.findEntry({ type: "custom" }))?.type).toBe("custom");
		await reopened.close();
	});

	it("refuses to clobber an existing id", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsh-repo-"));
		const repository = new DurableSessionRepository(new NodeDurableExecutionEnv({ cwd: root }), join(root, "sessions"));
		const first = await repository.create({ id: "same", cwd: root });
		await first.close();

		await expect(repository.create({ id: "same", cwd: root })).rejects.toThrow("Session already exists");
	});
});
