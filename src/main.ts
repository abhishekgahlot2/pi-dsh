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
		sessionsRoot: config.sessionsRoot,
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
			if (input === "/extension inspect") {
				stdout.write(`${JSON.stringify({ components: await session.inspectComponents(), extensions: await session.inspectExtensions() }, null, 2)}\n`);
				continue;
			}
			const approve = /^\/extension\s+approve\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(input);
			if (approve) {
				await session.approveExtension(approve[1]!, approve[2]!, approve[3]!);
				stdout.write(`extension ${approve[1]} revision ${approve[2]} approved\n`);
				continue;
			}
			const stopExtension = /^\/extension\s+stop\s+(\S+)$/.exec(input);
			if (stopExtension) {
				await session.stopExtension(stopExtension[1]!);
				stdout.write(`extension ${stopExtension[1]} stopped\n`);
				continue;
			}
			const runExtension = /^\/extension\s+run\s+(\S+)\s+(\S+)$/.exec(input);
			if (runExtension) {
				await session.runExtension(runExtension[1]!, runExtension[2]!);
				stdout.write(`extension ${runExtension[1]} revision ${runExtension[2]} running\n`);
				continue;
			}
			const rollbackExtension = /^\/extension\s+rollback\s+(\S+)\s+(\S+)$/.exec(input);
			if (rollbackExtension) {
				await session.rollbackExtension(rollbackExtension[1]!, rollbackExtension[2]!);
				stdout.write(`extension ${rollbackExtension[1]} rolled back to ${rollbackExtension[2]}\n`);
				continue;
			}
			const removeExtension = /^\/extension\s+remove\s+(\S+)$/.exec(input);
			if (removeExtension) {
				await session.removeExtension(removeExtension[1]!);
				stdout.write(`extension ${removeExtension[1]} removed\n`);
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
