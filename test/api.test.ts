import { createAssistantMessageEventStream, Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiDshRuntime, PiDshSessionError, type PiDshRuntimeOptions } from "../src/api.ts";
import { NodeDurableExecutionEnv } from "../src/env.ts";
import { DurableSessionRepository } from "../src/repo.ts";
import type { AgentTool, StreamFn } from "../vendor/pi/types.ts";

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

function assistant(stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: model.id,
		content: [{ type: "text", text: stopReason === "stop" ? "done" : "aborted" }],
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function assistantError(message: string): AssistantMessage {
	return {
		...assistant(),
		content: [],
		stopReason: "error",
		errorMessage: message,
	};
}

function assistantWithTool(): AssistantMessage {
	return {
		...assistant(),
		content: [{ type: "toolCall", id: "tool-1", name: "checkpoint", arguments: {} }],
		stopReason: "toolUse",
	};
}

function immediateStream(): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant() }));
		return stream;
	};
}

async function fixture(
	streamFn: StreamFn = immediateStream(),
	overrides: Partial<Omit<PiDshRuntimeOptions, "repository" | "streamFn" | "systemPrompt">> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pi-dsh-api-"));
	const repository = new DurableSessionRepository(new NodeDurableExecutionEnv({ cwd: root }), join(root, "sessions"));
	return {
		root,
		repository,
		runtime: new PiDshRuntime({ repository, model, streamFn, systemPrompt: "system", ...overrides }),
	};
}

describe("PiDshRuntime", () => {
	it("creates a session, emits events, and persists explicit constraints outside transcript", async () => {
		const { runtime, repository } = await fixture();
		const session = await runtime.createSession({ id: "api", cwd: "/workspace" });
		const events: string[] = [];
		session.subscribe((event) => {
			events.push(event.type);
		});
		await session.addConstraint("verify", "Always verify changes");
		const result = await session.prompt("hello");

		expect(result.findLast((message) => message.role === "assistant")).toMatchObject({ stopReason: "stop" });
		expect(events).toContain("agent_end");
		await session.close();

		const reopened = await repository.open("api");
		const messages = await reopened.session.findEntries({ type: "message" });
		expect(JSON.stringify(messages)).not.toContain("session-constraints");
		expect(await reopened.session.findEntry({ type: "custom", customType: "constraint/add" })).toBeDefined();
		await reopened.close();
	});

	it("isolates subscriber failures from the durable loop", async () => {
		const { runtime } = await fixture();
		const session = await runtime.createSession({ id: "subscriber-error", cwd: "/workspace" });
		session.subscribe(() => {
			throw new Error("subscriber failed");
		});
		await expect(session.prompt("hello")).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "assistant", stopReason: "stop" })]),
		);
		await session.close();
	});

	it("repairs an interrupted operation before exposing an opened session", async () => {
		const { runtime, repository } = await fixture();
		const handle = await repository.create({ id: "repair-on-open", cwd: "/workspace" });
		await handle.storage.appendRecord({
			type: "operation_started",
			id: "run-1",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});
		await handle.close();

		const opened = await runtime.openSession("repair-on-open");
		expect(opened.repair).toEqual({ runId: "run-1", appendedEntries: 0, appendedRecords: 1 });
		await opened.session.close();
	});

	it("records abort, drains the active run, closes, and releases the writer lock", async () => {
		const started = Promise.withResolvers<void>();
		const streamFn: StreamFn = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			started.resolve();
			options?.signal?.addEventListener(
				"abort",
				() => stream.push({ type: "error", reason: "aborted", error: assistant("aborted") }),
				{ once: true },
			);
			return stream;
		};
		const { runtime, repository } = await fixture(streamFn);
		const session = await runtime.createSession({ id: "abort", cwd: "/workspace" });
		const prompt = session.prompt("wait");
		await started.promise;
		await session.steer("change course");
		await session.close();
		await prompt;

		const reopened = await repository.open("abort");
		const log = await reopened.session.getLog();
		const recordTypes = log.flatMap((item) => (item.kind === "record" ? [item.record.type] : []));
		expect(recordTypes).toContain("abort_requested");
		expect(recordTypes).toContain("queue_enqueued");
		expect(recordTypes.indexOf("queue_enqueued")).toBeLessThan(recordTypes.indexOf("abort_requested"));
		expect(recordTypes.at(-1)).toBe("operation_finished");
		await reopened.close();
	});

	it("releases the writer lock even when runtime disposal reports an error", async () => {
		const { runtime, repository } = await fixture(immediateStream(), {
			disposeRuntimeContributions: () => {
				throw new Error("runtime dispose failed");
			},
		});
		const session = await runtime.createSession({ id: "dispose-error", cwd: "/workspace" });
		await session.prompt("hello");

		await expect(session.close()).rejects.toThrow("Session shutdown completed with errors");
		const reopened = await repository.open("dispose-error");
		await reopened.close();
	});

	it("rejects concurrent runs and work after close", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			started.resolve();
			void (async () => {
				await release.promise;
				stream.push({ type: "done", reason: "stop", message: assistant() });
			})();
			return stream;
		};
		const { runtime } = await fixture(streamFn);
		const session = await runtime.createSession({ id: "admission", cwd: "/workspace" });
		const first = session.prompt("first");
		await started.promise;
		expect(() => session.prompt("second")).toThrow("active run");
		release.resolve();
		await first;
		await session.close();
		await expect(session.followUp("later")).rejects.toThrow("closed");
	});

	it("keeps admission closed while post-run drain settles", async () => {
		const drainStarted = Promise.withResolvers<void>();
		const releaseDrain = Promise.withResolvers<void>();
		const { runtime } = await fixture(immediateStream(), {
			postRunDrain: async ({ lastOperation }) => {
				expect(lastOperation).toMatchObject({ outcome: "completed" });
				drainStarted.resolve();
				await releaseDrain.promise;
			},
		});
		const session = await runtime.createSession({ id: "post-run-drain", cwd: "/workspace" });

		const prompt = session.prompt("first");
		await drainStarted.promise;
		expect(() => session.prompt("second")).toThrow(PiDshSessionError);
		try {
			session.resume();
			throw new Error("resume should have failed");
		} catch (error) {
			expect(error).toBeInstanceOf(PiDshSessionError);
			expect((error as PiDshSessionError).code).toBe("SESSION_POST_RUN_DRAIN");
		}
		releaseDrain.resolve();
		await prompt;
		await session.close();
	});

	it("inspects the base component graph with provider marked non-replaceable", async () => {
		const tool: AgentTool = {
			name: "checkpoint",
			label: "Checkpoint",
			description: "Return a checkpoint",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "checkpoint complete" }], details: {} };
			},
		};
		const { runtime } = await fixture(immediateStream(), {
			tools: [tool],
			getRuntimeContributions: () => ({
				promptContributors: [{ id: "extension:hint", text: "Prefer the contributed workflow" }],
			}),
		});
		const session = await runtime.createSession({ id: "components", cwd: "/workspace" });

		await expect(session.inspectComponents()).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "provider:default",
					kind: "provider",
					replaceable: false,
					status: "active",
				}),
				expect.objectContaining({
					id: "tools:base",
					replaceable: true,
					details: { toolNames: ["checkpoint"] },
				}),
				expect.objectContaining({
					id: "prompt:base",
					replaceable: true,
					details: { contributorIds: ["extension:hint"] },
				}),
			]),
		);
		await session.close();
	});

	it("uses a replaced tools component on the next admitted request", async () => {
		const seenToolNames: string[][] = [];
		const streamFn: StreamFn = (_model, context) => {
			seenToolNames.push(context.tools?.map((tool) => tool.name) ?? []);
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant() }));
			return stream;
		};
		const oldTool: AgentTool = {
			name: "old-tool",
			label: "Old",
			description: "old",
			parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "old" }], details: {} }; },
		};
		const newTool: AgentTool = {
			name: "new-tool",
			label: "New",
			description: "new",
			parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "new" }], details: {} }; },
		};
		const { runtime } = await fixture(streamFn, { tools: [oldTool] });
		const session = await runtime.createSession({ id: "replace-tools", cwd: "/workspace" });

		await session.replaceComponent("tools:base", {
			id: "tools:base",
			kind: "tools",
			replaceable: true,
			activate: () => [newTool],
		});
		await session.prompt("hello");

		expect(seenToolNames[0]).toContain("new-tool");
		expect(seenToolNames[0]).not.toContain("old-tool");
		await session.close();
	});

	it("supports the complete human/API extension lifecycle while idle", async () => {
		const { runtime } = await fixture();
		const session = await runtime.createSession({ id: "human-extension", cwd: "/workspace" });
		const first = await session.defineExtension({
			extensionId: "human",
			purpose: "human lifecycle",
			source: "async (ctx) => {}",
			manifest: {},
		});
		await session.approveExtension("human", first.revisionId, first.sourceHash);
		await session.runExtension("human", first.revisionId);

		const second = await session.updateExtension({
			extensionId: "human",
			purpose: "human lifecycle revision two",
			source: "async (ctx) => { await ctx.now(); }",
			manifest: {},
		});
		await session.approveExtension("human", second.revisionId, second.sourceHash);
		await session.rollbackExtension("human", first.revisionId);
		expect((await session.inspectExtensions()).definitions[0]?.activeRevisionId).toBe(first.revisionId);
		await session.stopExtension("human");
		await session.removeExtension("human");
		expect((await session.inspectExtensions()).definitions).toEqual([]);
		await session.close();
	});

	it("compacts at a step boundary inside the active run", async () => {
		const responses = [assistantWithTool(), assistant()];
		let request = 0;
		const streamFn: StreamFn = () => {
			const message = responses[request++]!;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message }));
			return stream;
		};
		const tool: AgentTool = {
			name: "checkpoint",
			label: "Checkpoint",
			description: "Return a checkpoint",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "checkpoint complete" }], details: {} };
			},
		};
		const { runtime, repository } = await fixture(streamFn, {
			tools: [tool],
			summarizer: { async summarize() { return { summary: "short" }; } },
			compactionPolicy: { contextWindow: 1_000, retainedTailTokens: 100, thresholdRatio: 0.5 },
			loopConfig: { toolExecution: "sequential" },
		});
		const session = await runtime.createSession({ id: "threshold", cwd: "/workspace" });
		await session.prompt("x".repeat(4_000));
		await session.close();

		const reopened = await repository.open("threshold");
		expect(await reopened.session.findEntries({ type: "compaction" })).toHaveLength(1);
		const starts = await reopened.session.findRecords({ type: "operation_started" });
		expect(starts).toHaveLength(1);
		expect(starts[0]?.intent.kind).toBe("run");
		const step = (await reopened.session.findRecords({ type: "step_attempt", order: "oldestFirst" })).find(
			(record) => record.step === "compaction",
		);
		expect(step).toMatchObject({ step: "compaction", compactionReason: "threshold", runId: starts[0]?.id });
		await reopened.close();
	});

	it("forces overflow compaction and retries only after durable progress", async () => {
		const responses = [assistantError("maximum context length exceeded"), assistant()];
		let request = 0;
		const streamFn: StreamFn = () => {
			const message = responses[request++]!;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const { runtime, repository } = await fixture(streamFn, {
			summarizer: { async summarize() { return { summary: "short" }; } },
			compactionPolicy: { contextWindow: 1_000, retainedTailTokens: 100, maxOverflowRetries: 1 },
		});
		const session = await runtime.createSession({ id: "overflow", cwd: "/workspace" });
		const messages = await session.prompt("x".repeat(4_000));
		expect(messages.findLast((message) => message.role === "assistant")).toMatchObject({ stopReason: "stop" });
		expect(request).toBe(2);
		await session.close();

		const reopened = await repository.open("overflow");
		const [compaction] = await reopened.session.findEntries({ type: "compaction" });
		expect(compaction).toMatchObject({ type: "compaction", retainedTail: [] });
		const starts = await reopened.session.findRecords({ type: "operation_started" });
		expect(starts).toHaveLength(1);
		expect((await reopened.session.findRecords({ type: "operation_finished" }))[0]).toMatchObject({ outcome: "completed" });
		await reopened.close();
	});

	it("fails the operation for a non-overflow provider error", async () => {
		const message = assistantError("No API key available for provider");
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "error", reason: "error", error: message }));
			return stream;
		};
		const { runtime, repository } = await fixture(streamFn);
		const session = await runtime.createSession({ id: "provider-error", cwd: "/workspace" });
		await expect(session.prompt("hello")).rejects.toThrow("No API key");
		await session.close();

		const reopened = await repository.open("provider-error");
		expect((await reopened.session.findRecords({ type: "operation_finished" }))[0]).toMatchObject({ outcome: "failed" });
		await reopened.close();
	});

	it("defaults to a tree fork after constraint and compaction entries", async () => {
		const { runtime } = await fixture(immediateStream(), {
			summarizer: { async summarize() { return { summary: "short" }; } },
			compactionPolicy: { contextWindow: 1_000, retainedTailTokens: 0 },
		});
		const source = await runtime.createSession({ id: "fork-source", cwd: "/workspace" });
		await source.addConstraint("verify", "Always verify");
		await source.prompt("x".repeat(4_000));
		await source.compact({ reason: "manual" });

		const fork = await runtime.forkSession(source, { id: "fork-target" });
		await expect(fork.addConstraint("verify", "Duplicate")).rejects.toThrow("already active");
		await fork.close();
		await source.close();
	});
});
