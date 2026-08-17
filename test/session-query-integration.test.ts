import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionLockPath } from "../src/persistence.ts";
import { getSessionEventWindow, searchSessionEvents, traceSessionEvent } from "../src/session-query.ts";
import { createSessionQueryTools } from "../src/session-query-tools.ts";

async function tempSessionsRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsh-session-query-integration-"));
	const sessionsRoot = join(root, "sessions");
	await mkdir(sessionsRoot, { recursive: true });
	return sessionsRoot;
}

async function writeSession(root: string, id: string, lines: readonly Record<string, unknown>[], tail = "\n"): Promise<string> {
	const path = join(root, `${id}.jsonl`);
	await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}${tail}`);
	return path;
}

function header(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { kind: "header", version: 4, id, createdAt: 1_800_000_000_000, cwd: `/work/${id}`, ...fields };
}

function entry(fields: Record<string, unknown>): Record<string, unknown> {
	return { kind: "entry", lane: "main", timestamp: 1_800_000_000_000, ...fields };
}

function record(fields: Record<string, unknown>): Record<string, unknown> {
	return { kind: "record", lane: "main", timestamp: 1_800_000_000_000, ...fields };
}

describe("session query integration", () => {
	it("keeps runtime and model-facing tool projections aligned without writer locks", async () => {
		const root = await tempSessionsRoot();
		const rootPath = await writeSession(root, "root", [
			header("root"),
			record({ type: "operation_started", id: "run-root", seq: 1, sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } }),
			entry({ type: "message", id: "u1", seq: 2, parentId: null, message: { role: "user", content: "root asks for blue", timestamp: 1 } }),
			entry({ type: "message", id: "a1", seq: 3, parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "call-root", name: "lookup", arguments: {} }], stopReason: "toolUse", timestamp: 2 } }),
			record({ type: "tool_started", id: "tool-root", seq: 4, runId: "run-root", assistantEntryId: "a1", toolIndex: 0, toolCallId: "call-root", toolName: "lookup", effectiveArgs: {}, resultEntryId: "t1", replay: "safe" }),
			entry({ type: "message", id: "t1", seq: 5, parentId: "a1", message: { role: "toolResult", toolCallId: "call-root", content: [{ type: "text", text: "blue result" }], isError: false, timestamp: 3 } }),
			entry({ type: "custom", id: "intent-1", seq: 6, parentId: "t1", customType: "extension/intent-scheduled", data: { intentId: "intent-root", sessionId: "root", extensionId: "ext-root", revisionId: "rev-1", sourceHash: "sha", runId: "run-root", toolCallId: "call-root", requestedAction: "define" } }),
			entry({ type: "custom", id: "defined-1", seq: 7, parentId: "intent-1", customType: "extension/defined", data: { intentId: "intent-root", extensionId: "ext-root", revisionId: "rev-1", sourceHash: "sha" } }),
			record({ type: "operation_finished", id: "done-root", seq: 8, runId: "run-root", outcome: "completed" }),
		]);
		await writeSession(root, "child", [
			header("child", { parentSessionId: "root" }),
			entry({ type: "message", id: "child-u1", seq: 1, parentId: null, message: { role: "user", content: "child asks for blue", timestamp: 1 } }),
			entry({ type: "compaction", id: "child-c1", seq: 2, parentId: "child-u1", summary: "child summary", retainedTail: [], tokensBefore: 20, details: { shadowedEntryIds: ["child-u1"], retainedEntryIds: [] } }),
		]);
		await writeSession(root, "bad-sibling", [
			header("bad-sibling"),
			entry({ type: "message", id: "bad-u1", seq: 1, parentId: null, message: { role: "user", content: "blue before malformed", timestamp: 1 } }),
		], "\n{\"kind\":\"entry\"}\n");

		const runtimeSearch = await searchSessionEvents(root, { text: "blue", filters: { sessionId: "root" } });
		const tools = createSessionQueryTools({ sessionsRoot: root });
		const searchTool = tools.find((tool) => tool.name === "session_search");
		if (!searchTool) throw new Error("missing session_search tool");
		const toolSearch = await searchTool.execute("tool-call-1", { text: "blue", sessionId: "root" });
		expect(toolSearch.details).toMatchObject({
			results: runtimeSearch.results,
		});

		const window = await getSessionEventWindow(root, "root", 5, { before: 1, after: 1 });
		const trace = await traceSessionEvent(root, "root", 6);
		expect(window.events.map((event) => event.seq)).toEqual([4, 5, 6]);
		expect(trace.relationships).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "extension-intent-run", target: expect.objectContaining({ seq: 1 }) }),
				expect.objectContaining({ type: "extension-intent-tool", target: expect.objectContaining({ seq: 4 }) }),
				expect.objectContaining({ type: "extension-lifecycle", target: expect.objectContaining({ seq: 7 }) }),
			]),
		);
		expect(runtimeSearch.sessions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "bad-sibling", corruptionState: "malformed" })]),
		);
		await expect(readFile(sessionLockPath(rootPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});
});
