import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";

// Credential-bearing configuration stays outside durable request snapshots.

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_KEY_NAME = "openrouter_key";

export interface HarnessConfig {
	model: Model<"openai-completions">;
	apiKey: string;
	sessionsRoot: string;
	cwd: string;
}

export interface ConfigEnvironment {
	PIDSH_MODEL?: string;
	PIDSH_BASE_URL?: string;
	PIDSH_CONTEXT_WINDOW?: string;
	PIDSH_MAX_TOKENS?: string;
	PIDSH_SESSIONS_ROOT?: string;
	PIDSH_OPENROUTER_KEY_NAME?: string;
	OPENROUTER_API_KEY?: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function requiredText(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new ConfigError(`${name} is required`);
	return normalized;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ConfigError(`${name} must be a positive integer`);
	}
	return parsed;
}

async function readFallbackApiKey(path: string, keyName: string): Promise<string | undefined> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new ConfigError(`Unable to read API key fallback file: ${path}`);
	}
	for (const line of contents.split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
		if (match?.[1] === keyName && match[2]) return match[2];
	}
	return undefined;
}

export async function loadConfig(
	environment: ConfigEnvironment = process.env,
	options: { cwd?: string; keyFile?: string } = {},
): Promise<HarnessConfig> {
	const cwd = resolve(options.cwd ?? process.cwd());
	const modelId = requiredText(environment.PIDSH_MODEL, "PIDSH_MODEL");
	const keyName = environment.PIDSH_OPENROUTER_KEY_NAME?.trim() || DEFAULT_KEY_NAME;
	const apiKey = requiredText(
		environment.OPENROUTER_API_KEY ??
			(await readFallbackApiKey(options.keyFile ?? join(homedir(), "ai_keys_loop"), keyName)),
		"OPENROUTER_API_KEY",
	);
	const baseUrl = environment.PIDSH_BASE_URL?.trim() || DEFAULT_BASE_URL;
	const contextWindow = positiveInteger(environment.PIDSH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW, "PIDSH_CONTEXT_WINDOW");
	const maxTokens = positiveInteger(environment.PIDSH_MAX_TOKENS, DEFAULT_MAX_TOKENS, "PIDSH_MAX_TOKENS");

	return {
		apiKey,
		cwd,
		sessionsRoot: resolve(cwd, environment.PIDSH_SESSIONS_ROOT?.trim() || ".pi-dsh/sessions"),
		model: {
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: "openrouter",
			baseUrl,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
		},
	};
}
