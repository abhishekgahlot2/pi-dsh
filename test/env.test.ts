import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeDurableExecutionEnv } from "../src/env.ts";

describe("NodeDurableExecutionEnv", () => {
	it("enforces the 600 second command timeout cap", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-dsh-env-"));
		const result = await new NodeDurableExecutionEnv({ cwd }).exec("true", { timeout: 601 });
		expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
	});
});
