import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
	it("requires model configuration", async () => {
		await expect(loadConfig({ OPENROUTER_API_KEY: "secret" }, { cwd: "/tmp", keyFile: "/missing" })).rejects.toEqual(
			expect.objectContaining<Partial<ConfigError>>({ name: "ConfigError", message: "PIDSH_MODEL is required" }),
		);
	});

	it("reads the fallback key without exposing it through the model", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-dsh-config-"));
		const keyFile = join(directory, "keys");
		await writeFile(keyFile, "other=value\nopenrouter_key=fallback-secret\n", "utf8");

		const config = await loadConfig({ PIDSH_MODEL: "configured-model" }, { cwd: directory, keyFile });

		expect(config.apiKey).toBe("fallback-secret");
		expect(config.model.id).toBe("configured-model");
		expect(JSON.stringify(config.model)).not.toContain("fallback-secret");
	});

	it("selects a named key from the fallback file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-dsh-config-"));
		const keyFile = join(directory, "keys");
		await writeFile(keyFile, "openrouter_key=old-secret\ncurrent_key=current-secret\n", "utf8");

		const config = await loadConfig(
			{ PIDSH_MODEL: "configured-model", PIDSH_OPENROUTER_KEY_NAME: "current_key" },
			{ cwd: directory, keyFile },
		);

		expect(config.apiKey).toBe("current-secret");
	});

	it("rejects invalid numeric model limits", async () => {
		await expect(
			loadConfig(
				{ PIDSH_MODEL: "configured-model", OPENROUTER_API_KEY: "secret", PIDSH_CONTEXT_WINDOW: "0" },
				{ cwd: "/tmp", keyFile: "/missing" },
			),
		).rejects.toThrow("PIDSH_CONTEXT_WINDOW must be a positive integer");
	});
});
