import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiDshRuntime } from "../src/api.ts";
import { NodeDurableExecutionEnv } from "../src/env.ts";
import { DurableSessionRepository } from "../src/repo.ts";
import { traceSessionEvent } from "../src/session-query.ts";
import type { StreamFn } from "../vendor/pi/types.ts";

const model = {
	provider: "openai",
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} satisfies Model<"openai-completions">;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const sourceSentinel = "SELF_EXTENSION_SOURCE_SENTINEL";
const source = `async (ctx) => {
	const marker = "${sourceSentinel}";
	ctx.registerTool({ name: "echo", description: marker, inputSchema: { type: "object" } }, async (args) => args);
	ctx.registerPrompt({ id: "echo-hint", text: "Use the echo extension when asked." });
}`;
const manifest = {
	tools: [{ name: "echo", description: sourceSentinel, inputSchema: { type: "object" } }],
	prompts: [{ id: "echo-hint", text: "Use the echo extension when asked." }],
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: model.id,
		content,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>): AssistantMessage {
	return assistant([{ type: "toolCall", id, name, arguments: arguments_ }], "toolUse");
}

function scriptedStream(
	responses: readonly AssistantMessage[],
	contexts: CapturedContext[],
): StreamFn {
	let request = 0;
	return (_model, context) => {
		contexts.push({
			messages: structuredClone(context.messages),
			toolNames: context.tools?.map((tool) => tool.name) ?? [],
		});
		const message = responses[request++];
		if (message === undefined) throw new Error(`Missing scripted response ${request}`);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({
			type: "done",
			reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		}));
		return stream;
	};
}

interface CapturedContext {
	readonly messages: Context["messages"];
	readonly toolNames: readonly string[];
}

describe("self-extension lifecycle", () => {
	it("defines, approves, runs, uses, traces, stops, and forgets a process-local extension", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsh-self-extension-"));
		const sessionsRoot = join(root, "sessions");
		const repository = new DurableSessionRepository(new NodeDurableExecutionEnv({ cwd: root }), sessionsRoot);
		const contexts: CapturedContext[] = [];
		const responses: AssistantMessage[] = [
			toolCall("define-call", "extension_define", { extensionId: "demo", purpose: "echo test", source, manifest }),
			assistant([{ type: "text", text: "definition scheduled" }], "stop"),
		];
		const runtime = new PiDshRuntime({
			repository,
			model,
			streamFn: scriptedStream(responses, contexts),
			systemPrompt: "system",
			sessionsRoot,
		});
		const session = await runtime.createSession({ id: "self-extension", cwd: root });

		await session.prompt("define an echo extension");
		const defined = await session.inspectExtensions();
		const revision = defined.definitions[0]?.revisions[0];
		expect(revision).toMatchObject({ extensionId: "demo", approved: false });
		if (revision === undefined) throw new Error("Expected extension revision");
		await session.approveExtension("demo", revision.revisionId, revision.sourceHash);

		responses.push(
			toolCall("run-call", "extension_run", { extensionId: "demo", revisionId: revision.revisionId, sourceHash: revision.sourceHash }),
			assistant([{ type: "text", text: "run scheduled" }], "stop"),
			toolCall("echo-call", "echo", { value: "hello" }),
			assistant([{ type: "text", text: "echo complete" }], "stop"),
			toolCall("stop-call", "extension_stop", { extensionId: "demo" }),
			assistant([{ type: "text", text: "stop scheduled" }], "stop"),
			assistant([{ type: "text", text: "after stop" }], "stop"),
		);

		await session.prompt("run it");
		expect((await session.inspectExtensions()).running).toHaveLength(1);
		await session.prompt("use echo");
		await session.prompt("stop it");
		expect((await session.inspectExtensions()).running).toHaveLength(0);
		await session.prompt("confirm stopped");

		const toolViews = contexts.map((context) => context.toolNames);
		expect(toolViews.some((tools) => tools.includes("echo"))).toBe(true);
		expect(toolViews.at(-1)).not.toContain("echo");
		expect(contexts.some((context) => JSON.stringify(context.messages).includes("echo-hint"))).toBe(true);

		await session.close();
		const raw = await readFile(join(sessionsRoot, "self-extension.jsonl"), "utf8");
		expect(raw).toContain(sourceSentinel);
		for (const line of raw.trimEnd().split("\n").slice(1)) {
			const value = JSON.parse(line) as { kind?: string; type?: string; customType?: string; data?: unknown };
			if (value.kind === "entry" && value.type === "custom" && value.customType?.startsWith("extension/")) {
				expect(JSON.stringify(value.data)).not.toContain(sourceSentinel);
			}
		}

		const handle = await repository.open("self-extension");
		const intent = await handle.session.findEntry({ type: "custom", customType: "extension/intent-scheduled" });
		const toolStarts = await handle.session.findRecords({ type: "tool_started", order: "oldestFirst" });
		expect(toolStarts.find((record) => record.toolName === "echo")).toBeDefined();
		await handle.close();
		if (intent === undefined) throw new Error("Expected durable extension intent");
		const trace = await traceSessionEvent(sessionsRoot, "self-extension", intent.seq);
		expect(trace.relationships.map((relationship) => relationship.type)).toEqual(
			expect.arrayContaining(["extension-intent-run", "extension-intent-tool", "extension-lifecycle"]),
		);

		const reopened = await runtime.openSession("self-extension");
		expect((await reopened.session.inspectExtensions()).definitions).toEqual([]);
		await reopened.session.close();
	});

	it("preempts a non-yielding extension during post-run drain and admits later work", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-dsh-self-extension-loop-"));
		const sessionsRoot = join(root, "sessions");
		const repository = new DurableSessionRepository(new NodeDurableExecutionEnv({ cwd: root }), sessionsRoot);
		const loopSource = "async (ctx) => { while (true) {} }";
		const responses: AssistantMessage[] = [
			toolCall("define-loop", "extension_define", { extensionId: "loop", purpose: "preemption test", source: loopSource, manifest: {} }),
			assistant([{ type: "text", text: "definition scheduled" }], "stop"),
		];
		const runtime = new PiDshRuntime({
			repository,
			model,
			streamFn: scriptedStream(responses, []),
			systemPrompt: "system",
			sessionsRoot,
		});
		const session = await runtime.createSession({ id: "loop-drain", cwd: root });

		await session.prompt("define loop");
		const revision = (await session.inspectExtensions()).definitions[0]?.revisions[0];
		if (revision === undefined) throw new Error("Expected loop revision");
		await session.approveExtension("loop", revision.revisionId, revision.sourceHash);
		responses.push(
			toolCall("run-loop", "extension_run", { extensionId: "loop", revisionId: revision.revisionId, sourceHash: revision.sourceHash }),
			assistant([{ type: "text", text: "run scheduled" }], "stop"),
			assistant([{ type: "text", text: "still responsive" }], "stop"),
		);

		const parentTick = new Promise<"responsive">((resolve) => setTimeout(() => resolve("responsive"), 25));
		const run = session.prompt("run loop");
		await expect(parentTick).resolves.toBe("responsive");
		await expect(run).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant" })]));
		expect((await session.inspectExtensions()).running).toEqual([]);
		await expect(session.prompt("continue after failed extension")).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "still responsive" }] })]),
		);
		await expect(session.close()).resolves.toBeUndefined();

		const handle = await repository.open("loop-drain");
		const failures = await handle.session.findEntries({ type: "custom", customType: "extension/failed" });
		expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ code: "EXTENSION_ACTIVATION_TIMEOUT" }) })]));
		await handle.close();
	});
});
