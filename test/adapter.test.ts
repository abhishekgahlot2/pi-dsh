import { deepStrictEqual, ok } from "node:assert/strict";
import {
	createAssistantMessageEventStream,
	Type,
	type AssistantMessage,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PiDshLoopAdapter } from "../src/adapter.ts";
import { InMemorySessionRepo } from "../vendor/pi/harness/session/memory.ts";
import type { MessageEntry, ToolStartedRecord } from "../vendor/pi/harness/session/types.ts";
import type { AgentLoopConfig, AgentTool, StreamFn } from "../vendor/pi/types.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
} satisfies Model<any>;

function assistantWithTool(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		content: [{ type: "toolCall", id: "call-1", name: "checkpoint", arguments: { input: "x" } }],
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function assistantDone(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		content: [{ type: "text", text: "done" }],
		usage,
		stopReason: "stop",
		timestamp: 2,
	};
}

function streamOne(message: AssistantMessage): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: message.stopReason === "stop" ? "stop" : "toolUse", message });
		});
		return stream;
	};
}

function streamSequence(messages: AssistantMessage[]): StreamFn {
	let index = 0;
	return () => streamOne(messages[Math.min(index++, messages.length - 1)]!)({} as Model<any>, { messages: [] });
}

describe("PiDshLoopAdapter", () => {
	it("persists operation, prompt, assistant, tool checkpoint, tool result, and finish records", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "adapter-session" });
		let observedToolStartedBeforeBody = false;
		const tool: AgentTool<any> = {
			name: "checkpoint",
			description: "checkpoint",
			label: "Checkpoint",
			parameters: Type.Object({ input: Type.String() }),
			async execute() {
				const toolStarted = await session.findRecords({ type: "tool_started", runId: "id-1" });
				observedToolStartedBeforeBody = toolStarted.length === 1;
				return { content: [{ type: "text", text: "tool ok" }], details: {} };
			},
		};
		const config = {
			model,
			toolExecution: "sequential",
			convertToLlm: asMessages,
		} satisfies AgentLoopConfig;
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [], tools: [tool] },
			config,
			streamFn: streamSequence([assistantWithTool(), assistantDone()]),
			idGenerator: idSequence(),
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "hi", timestamp: 1 }] });

		ok(observedToolStartedBeforeBody);
		const log = await session.getLog();
		deepStrictEqual(
			log.map((item) =>
				item.kind === "record" ? item.record.type : item.kind === "entry" ? `${item.kind}:${item.entry.type}` : item.kind,
			),
			[
				"operation_started",
				"entry:message",
				"entry:custom",
				"step_attempt",
				"entry:message",
				"usage",
				"tool_started",
				"entry:message",
				"entry:custom",
				"step_attempt",
				"entry:message",
				"usage",
				"operation_finished",
			],
		);
		const toolStarted = (await session.findRecords({ type: "tool_started" }))[0] as ToolStartedRecord;
		const durableResult = await session.getEntry(toolStarted.resultEntryId);
		expect(durableResult).toMatchObject({ type: "message", message: { role: "toolResult", toolCallId: "call-1" } });
	});

	it("persists steering and follow-up queue records using Pi vocabulary", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "queues" });
		let streamCount = 0;
		const streamFn: StreamFn = () => streamOne(streamCount++ === 0 ? assistantDone() : assistantDone())(model, {
			systemPrompt: "",
			messages: [],
		});
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: {
				model,
				convertToLlm: asMessages,
				getSteeringMessages: once([{ role: "user", content: "steer", timestamp: 2 }]),
				getFollowUpMessages: once([{ role: "user", content: "follow", timestamp: 3 }]),
				shouldStopAfterTurn: ({ newMessages }) => newMessages.length >= 4,
			},
			streamFn,
			idGenerator: idSequence(),
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "start", timestamp: 1 }] });

		const queues = await session.findRecords({ type: "queue_enqueued", order: "oldestFirst" });
		deepStrictEqual(
			queues.map((record) => record.queue),
			["steer", "followUp"],
		);
	});

	it("continues from repair-safe context that omits a trailing aborted assistant", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "continue" });
		await session.appendEntry<MessageEntry>(
			{ type: "message", id: "u1", message: { role: "user", content: "resume", timestamp: 1 } },
			"main",
		);
		await session.appendEntry<MessageEntry>(
			{ type: "message", id: "a1", message: { ...assistantDone(), stopReason: "aborted" } },
			"main",
		);
		let requestRoles: string[] = [];
		const streamFn: StreamFn = (_model, context) => {
			requestRoles = context.messages.map((message) => message.role);
			return streamOne(assistantDone())(_model, context);
		};
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: { model, convertToLlm: asMessages },
			streamFn,
			idGenerator: idSequence(),
		});

		await adapter.continue();

		deepStrictEqual(requestRoles, ["user"]);
	});

	it("does not pass keys or headers into persisted request snapshots", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "snapshots" });
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: {
				model,
				apiKey: "secret",
				headers: { authorization: "secret" },
				convertToLlm: asMessages,
			},
			streamFn: streamOne(assistantDone()),
			idGenerator: idSequence(),
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "start", timestamp: 1 }] });

		const serializedLog = JSON.stringify(await session.getLog());
		expect(serializedLog).not.toContain("secret");
		const [snapshot] = await session.findEntries({ type: "custom", customType: "request-header" });
		expect(snapshot).toMatchObject({
			type: "custom",
			data: { model: { id: "test-model", provider: "openai", api: "openai-completions" } },
		});
	});

	it("injects active constraints into requests without persisting them as transcript messages", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "constraints" });
		await session.appendCustomEntry("constraint/add", { id: "no-x", text: "Never use library X" });
		let requestMessages: Message[] = [];
		const streamFn: StreamFn = (requestModel, context) => {
			requestMessages = [...context.messages];
			return streamOne(assistantDone())(requestModel, context);
		};
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: { model, convertToLlm: asMessages },
			streamFn,
			idGenerator: idSequence(),
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "start", timestamp: 1 }] });

		expect(JSON.stringify(requestMessages)).toContain("Never use library X");
		const messages = await session.findEntries({ type: "message", order: "oldestFirst" });
		expect(JSON.stringify(messages)).not.toContain("session-constraints");
	});

	it("injects runtime prompt contributors into request snapshots", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "prompt-contributors" });
		let requestMessages: Message[] = [];
		const streamFn: StreamFn = (requestModel, context) => {
			requestMessages = [...context.messages];
			return streamOne(assistantDone())(requestModel, context);
		};
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: { model, convertToLlm: asMessages },
			streamFn,
			idGenerator: idSequence(),
			getRuntimeContributions: () => ({
				promptContributors: [{ id: "extension:hint", text: "Prefer the contributed workflow" }],
			}),
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "start", timestamp: 1 }] });

		expect(JSON.stringify(requestMessages)).toContain("Prefer the contributed workflow");
		const [snapshot] = await session.findEntries({ type: "custom", customType: "request-header" });
		expect(snapshot).toMatchObject({
			type: "custom",
			data: {
				promptContributors: [{ id: "extension:hint", text: "Prefer the contributed workflow" }],
			},
		});
	});

	it("keeps runtime tool contributions stable for the whole operation", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "runtime-tools" });
		let contributionSnapshots = 0;
		const runtimeTool: AgentTool = {
			name: "checkpoint",
			description: "checkpoint",
			label: "Checkpoint",
			parameters: Type.Object({ input: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "runtime tool ok" }], details: {} };
			},
		};
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: {
				model,
				toolExecution: "sequential",
				convertToLlm: asMessages,
			},
			streamFn: streamSequence([assistantWithTool(), assistantDone()]),
			idGenerator: idSequence(),
			getRuntimeContributions: () => {
				contributionSnapshots += 1;
				return { tools: [runtimeTool] };
			},
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "hi", timestamp: 1 }] });

		expect(contributionSnapshots).toBe(1);
		const toolStarted = await session.findRecords({ type: "tool_started" });
		expect(toolStarted).toHaveLength(1);
		const messages = await session.findEntries({ type: "message", order: "oldestFirst" });
		expect(JSON.stringify(messages)).toContain("runtime tool ok");
	});

	it("calls the operation-finished hook after the durable finish record is appended", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "finish-hook" });
		let finishHookSawRecord = false;
		const adapter = new PiDshLoopAdapter({
			store: session,
			context: { systemPrompt: "system", messages: [] },
			config: { model, convertToLlm: asMessages },
			streamFn: streamOne(assistantDone()),
			idGenerator: idSequence(),
			onOperationFinished: async ({ runId, outcome }) => {
				const records = await session.findRecords({ type: "operation_finished", runId });
				finishHookSawRecord = records.length === 1 && outcome === "completed";
			},
		});

		await adapter.runPrompt({ prompts: [{ role: "user", content: "start", timestamp: 1 }] });

		expect(finishHookSawRecord).toBe(true);
	});
});

function idSequence(): () => string {
	let value = 0;
	return () => `id-${++value}`;
}

function once<T>(value: T): () => Promise<T | []> {
	let used = false;
	return async () => {
		if (used) return [];
		used = true;
		return value;
	};
}

function asMessages(messages: readonly unknown[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
	);
}
