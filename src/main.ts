import { contentText } from "@earendil-works/pi-ai";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { PiDshRuntime } from "./api.ts";
import { loadConfig } from "./config.ts";
import { NodeDurableExecutionEnv } from "./env.ts";
import { createStreamFn } from "./provider.ts";
import { DurableSessionRepository } from "./repo.ts";
import { ModelCompactionSummarizer } from "./summarizer.ts";
import { createDefaultTools } from "./tools.ts";

// Minimal terminal composition with ordered shutdown and explicit constraint commands.

const SYSTEM_PROMPT = "You are a coding agent. Use tools when needed, be concise, and verify your work.";

function resumeId(arguments_: readonly string[]): string | undefined {
	const index = arguments_.indexOf("--resume");
	if (index === -1) return undefined;
	const value = arguments_[index + 1];
	if (!value) throw new Error("--resume requires a session id");
	return value;
}

async function main(): Promise<void> {
	const config = await loadConfig();
	const env = new NodeDurableExecutionEnv({ cwd: config.cwd });
	const streamFn = createStreamFn(config);
	const runtime = new PiDshRuntime({
		repository: new DurableSessionRepository(env, config.sessionsRoot),
		model: config.model,
		streamFn,
		systemPrompt: SYSTEM_PROMPT,
		tools: createDefaultTools({ env }),
		summarizer: new ModelCompactionSummarizer(config.model, streamFn),
	});
	const requestedId = resumeId(process.argv.slice(2));
	const opened = requestedId
		? await runtime.openSession(requestedId)
		: { session: await runtime.createSession({ cwd: config.cwd }), repair: undefined };
	const session = opened.session;
	stdout.write(`session ${await session.id}\n`);
	if (opened.repair?.runId) stdout.write(`repaired interrupted run ${opened.repair.runId}\n`);

	const terminal = createInterface({ input: stdin, output: stdout });
	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		terminal.close();
		await session.close();
	};
	process.once("SIGINT", () => void close());
	process.once("SIGTERM", () => void close());

	try {
		while (!closing) {
			const input = (await terminal.question("> ")).trim();
			if (!input) continue;
			if (input === "/quit" || input === "/exit") break;
			if (input === "/compact") {
				const result = await session.compact({ reason: "manual" });
				stdout.write(result ? `compacted to ${result.compaction.id}\n` : "nothing to compact\n");
				continue;
			}
			const add = /^\/constraint\s+add\s+(\S+)\s+(.+)$/.exec(input);
			if (add) {
				await session.addConstraint(add[1]!, add[2]!);
				stdout.write(`constraint ${add[1]} added\n`);
				continue;
			}
			const revoke = /^\/constraint\s+revoke\s+(\S+)$/.exec(input);
			if (revoke) {
				await session.revokeConstraint(revoke[1]!);
				stdout.write(`constraint ${revoke[1]} revoked\n`);
				continue;
			}
			const messages = await session.prompt(input);
			const assistant = messages.findLast((message) => message.role === "assistant");
			if (assistant?.role === "assistant") stdout.write(`${contentText(assistant.content)}\n`);
		}
	} finally {
		await close();
	}
}

await main();
