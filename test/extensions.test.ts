import { describe, expect, it } from "vitest";
import { ExtensionRuntime, ExtensionRuntimeError, validateExtensionSource, type ExtensionReceipt } from "../src/extensions.ts";
import { createExtensionLifecycleTools, createPiToolsForExtensionRuntime } from "../src/extension-tools.ts";

const manifest = {
	tools: [{ name: "echo", description: "Echo JSON" }],
	prompts: [{ id: "static-note", text: "Use the echo extension when asked." }],
};

function runtime(options: Partial<ConstructorParameters<typeof ExtensionRuntime>[0]> = {}): ExtensionRuntime {
	return new ExtensionRuntime({
		sessionId: "session-a",
		activationTimeoutMs: 100,
		handlerTimeoutMs: 100,
		abortGraceMs: 10,
		disposeTimeoutMs: 100,
		idGenerator: createCounterIds(),
		now: () => 123,
		querySession: (request) => ({ request }),
		...options,
	});
}

describe("validateExtensionSource", () => {
	it("accepts only the exact async function-expression contract", () => {
		expect(() => validateExtensionSource("async (ctx) => { await ctx.now(); }")).not.toThrow();
		expect(() => validateExtensionSource("(async (ctx) => { await ctx.now(); })")).not.toThrow();

		for (const source of [
			"export default async (ctx) => {}",
			"import fs from 'node:fs'; async (ctx) => {}",
			"async function extension(ctx) {}",
			"(ctx) => {}",
			"async (context) => {}",
			"async (ctx) => {}; async (ctx) => {}",
		]) {
			expect(() => validateExtensionSource(source), source).toThrow(expect.objectContaining({ code: "EXTENSION_SOURCE_SYNTAX" }));
		}
	});

	it("bounds source and manifest sizes before creating a revision", async () => {
		expect(() => validateExtensionSource(`async (ctx) => { /* ${"x".repeat(65_536)} */ }`)).toThrow(
			expect.objectContaining({ code: "EXTENSION_SOURCE_SYNTAX" }),
		);
		await expect(runtime().define({
			extensionId: "too-many-tools",
			purpose: "test",
			source: "async (ctx) => {}",
			manifest: { tools: Array.from({ length: 17 }, (_, index) => ({ name: `tool_${index}` })) },
		})).rejects.toMatchObject({ code: "EXTENSION_SOURCE_SYNTAX" });
	});
});

describe("ExtensionRuntime", () => {
	it("binds approval to session, revision, and source hash before running", async () => {
		const extensions = runtime();
		const revision = await extensions.define({
			extensionId: "demo",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'echo' }, async (args) => args); ctx.registerPrompt({ id: 'static-note', text: 'Use the echo extension when asked.' }); }",
			manifest,
			metadata: { reviewed: true },
		});

		await expect(extensions.run({ sessionId: "session-a", extensionId: "demo", revisionId: revision.revisionId })).rejects.toMatchObject({
			code: "EXTENSION_NOT_APPROVED",
		});
		await expect(
			extensions.approve({
				sessionId: "other-session",
				extensionId: "demo",
				revisionId: revision.revisionId,
				sourceHash: revision.sourceHash,
			}),
		).rejects.toMatchObject({ code: "EXTENSION_SESSION_MISMATCH" });
		await expect(
			extensions.approve({
				sessionId: "session-a",
				extensionId: "demo",
				revisionId: revision.revisionId,
				sourceHash: "changed",
			}),
		).rejects.toMatchObject({ code: "EXTENSION_SOURCE_CHANGED" });
	});

	it("rolls back intent, definition, and approval state when durable receipts fail", async () => {
		let rejectReceipt = true;
		const extensions = runtime({
			onReceipt: () => {
				if (rejectReceipt) throw new Error("receipt append failed");
			},
		});
		await expect(extensions.scheduleIntent({
			requestedAction: "stop",
			extensionId: "demo",
			runId: "run-1",
			toolCallId: "call-1",
		})).rejects.toThrow("receipt append failed");
		expect(extensions.inspect().scheduled).toEqual([]);

		await expect(extensions.define({
			extensionId: "demo",
			purpose: "test",
			source: "async (ctx) => {}",
			manifest: {},
		})).rejects.toThrow("receipt append failed");
		expect(extensions.inspect().definitions).toEqual([]);

		rejectReceipt = false;
		const revision = await extensions.define({
			extensionId: "demo",
			purpose: "test",
			source: "async (ctx) => {}",
			manifest: {},
		});
		rejectReceipt = true;
		await expect(extensions.approve({
			sessionId: "session-a",
			extensionId: "demo",
			revisionId: revision.revisionId,
			sourceHash: revision.sourceHash,
		})).rejects.toThrow("receipt append failed");
		expect(extensions.inspect().definitions[0]?.revisions[0]).toMatchObject({ approved: false });
	});

	it("activates in a worker, buffers registrations transactionally, and exposes matching contributions", async () => {
		const receipts: ExtensionReceipt[] = [];
		const extensions = runtime({ onReceipt: (receipt) => {
			receipts.push(receipt);
		} });
		const revision = await extensions.define({
			extensionId: "demo",
			purpose: "test",
			source: "async (ctx) => { const stamp = await ctx.now(); ctx.registerTool({ name: 'echo' }, async (args, call) => ({ args, stamp, id: await ctx.id(), toolCallId: call.toolCallId, frozen: Object.isFrozen(args) && Object.isFrozen(call), hasStream: 'onUpdate' in call })); ctx.registerPrompt({ id: 'static-note', text: 'Use the echo extension when asked.' }); }",
			manifest,
		});
		await extensions.approve({ sessionId: "session-a", extensionId: "demo", revisionId: revision.revisionId, sourceHash: revision.sourceHash });

		const contribution = await extensions.run({ sessionId: "session-a", extensionId: "demo", revisionId: revision.revisionId });
		expect(contribution.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(contribution.prompts).toEqual([{ id: "static-note", text: "Use the echo extension when asked." }]);

		const result = await contribution.tools[0].execute({ ok: true }, { toolCallId: "tool-1" });
		expect(result).toEqual({
			args: { ok: true },
			stamp: 123,
			id: `session-a:demo:${revision.revisionId}`,
			toolCallId: "tool-1",
			frozen: true,
			hasStream: false,
		});
		expect(receipts.map((receipt) => receipt.type)).toContain("extension/started");
		expect(JSON.stringify(receipts)).not.toContain("ctx.registerTool");
	});

	it("rolls back partial registrations on manifest mismatch", async () => {
		const extensions = runtime();
		const revision = await extensions.define({
			extensionId: "bad",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'echo' }, async () => null); ctx.registerTool({ name: 'extra' }, async () => null); }",
			manifest: { tools: [{ name: "echo" }] },
		});
		await extensions.approve({ sessionId: "session-a", extensionId: "bad", revisionId: revision.revisionId, sourceHash: revision.sourceHash });

		await expect(extensions.run({ sessionId: "session-a", extensionId: "bad", revisionId: revision.revisionId })).rejects.toMatchObject({
			code: "EXTENSION_MANIFEST_MISMATCH",
		});
		expect(extensions.getContributions()).toEqual([]);
	});

	it("rejects extension tools that collide with reserved runtime tools", async () => {
		const extensions = runtime({ reservedToolNames: ["read", "session_search"] });
		await expect(extensions.define({
			extensionId: "collision",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'read' }, async () => null); }",
			manifest: { tools: [{ name: "read" }] },
		})).rejects.toMatchObject({ code: "EXTENSION_MANIFEST_MISMATCH" });
		expect(extensions.inspect().definitions).toEqual([]);
	});

	it("preempts a synchronous infinite loop during activation without blocking the parent", async () => {
		const extensions = runtime({ activationTimeoutMs: 50 });
		const revision = await extensions.define({
			extensionId: "loop",
			purpose: "test",
			source: "async (ctx) => { while (true) {} }",
			manifest: {},
		});
		await extensions.approve({ sessionId: "session-a", extensionId: "loop", revisionId: revision.revisionId, sourceHash: revision.sourceHash });

		const tick = new Promise<"responsive">((resolve) => setTimeout(() => resolve("responsive"), 10));
		const run = extensions.run({ sessionId: "session-a", extensionId: "loop", revisionId: revision.revisionId });
		await expect(tick).resolves.toBe("responsive");
		await expect(run).rejects.toMatchObject({ code: "EXTENSION_ACTIVATION_TIMEOUT" });
		await expect(extensions.close()).resolves.toBeUndefined();
	});

	it("maps worker crashes, malformed messages, and non-JSON handler results to stable errors", async () => {
		const crash = runtime();
		const crashRevision = await crash.define({
			extensionId: "crash",
			purpose: "test",
			source: "async (ctx) => { throw new Error('boom'); }",
			manifest: {},
		});
		await crash.approve({ sessionId: "session-a", extensionId: "crash", revisionId: crashRevision.revisionId, sourceHash: crashRevision.sourceHash });
		await expect(crash.run({ sessionId: "session-a", extensionId: "crash", revisionId: crashRevision.revisionId })).rejects.toMatchObject({
			code: "EXTENSION_ACTIVATION_FAILED",
		});

		const protocol = runtime();
		const protocolRevision = await protocol.define({
			extensionId: "protocol",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'echo' }, async () => undefined); }",
			manifest: { tools: [{ name: "echo" }] },
		});
		await protocol.approve({
			sessionId: "session-a",
			extensionId: "protocol",
			revisionId: protocolRevision.revisionId,
			sourceHash: protocolRevision.sourceHash,
		});
		const contribution = await protocol.run({ sessionId: "session-a", extensionId: "protocol", revisionId: protocolRevision.revisionId });
		await expect(contribution.tools[0].execute({}, { toolCallId: "bad-json" })).rejects.toMatchObject({ code: "EXTENSION_RESULT_NOT_JSON" });
	});

	it("terminates a synchronous infinite loop in a handler and removes contributions", async () => {
		const extensions = runtime({ handlerTimeoutMs: 30, abortGraceMs: 10 });
		const revision = await extensions.define({
			extensionId: "handler-loop",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'echo' }, async () => { while (true) {} }); }",
			manifest: { tools: [{ name: "echo" }] },
		});
		await extensions.approve({ sessionId: "session-a", extensionId: "handler-loop", revisionId: revision.revisionId, sourceHash: revision.sourceHash });
		const contribution = await extensions.run({ sessionId: "session-a", extensionId: "handler-loop", revisionId: revision.revisionId });

		await expect(contribution.tools[0].execute({}, { toolCallId: "tool-loop" })).rejects.toMatchObject({ code: "EXTENSION_HANDLER_TIMEOUT" });
		expect(extensions.getContributions()).toEqual([]);
	});
});

describe("extension tool adapters", () => {
	it("model-facing lifecycle tools schedule direct intent metadata without applying lifecycle mutations", async () => {
		const receipts: ExtensionReceipt[] = [];
		const extensions = runtime({ onReceipt: (receipt) => {
			receipts.push(receipt);
		} });
		const defineTool = createExtensionLifecycleTools(extensions, { getRunId: () => "run-1" }).find((tool) => tool.name === "extension_define");
		if (defineTool === undefined) throw new Error("missing define tool");

		const result = await defineTool.execute("tool-call-1", {
			extensionId: "demo",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'echo' }, async (args) => args); }",
			manifest: { tools: [{ name: "echo" }] },
		});

		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(receipts).toHaveLength(1);
		expect(receipts[0].intent).toMatchObject({
			sessionId: "session-a",
			extensionId: "demo",
			runId: "run-1",
			toolCallId: "tool-call-1",
			requestedAction: "define",
		});
		expect(extensions.inspect().definitions).toEqual([]);
	});

	it("adapts active extension tools to Pi AgentTool results", async () => {
		const extensions = runtime();
		const revision = await extensions.define({
			extensionId: "demo",
			purpose: "test",
			source: "async (ctx) => { ctx.registerTool({ name: 'echo' }, async (args) => args); }",
			manifest: { tools: [{ name: "echo" }] },
		});
		await extensions.approve({ sessionId: "session-a", extensionId: "demo", revisionId: revision.revisionId, sourceHash: revision.sourceHash });
		await extensions.run({ sessionId: "session-a", extensionId: "demo", revisionId: revision.revisionId });

		const [tool] = createPiToolsForExtensionRuntime(extensions);
		const result = await tool.execute("tool-1", { hello: "world" });
		expect(result.details).toEqual({ hello: "world" });
		expect(result.content).toEqual([{ type: "text", text: "{\"hello\":\"world\"}" }]);
	});
});

function createCounterIds(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}
