import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionLockPath } from "../src/persistence.ts";
import {
	SessionQueryError,
	getSessionEventWindow,
	getSessionLineage,
	searchSessionEvents,
	traceSessionEvent,
} from "../src/session-query.ts";

async function tempSessionsRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsh-session-query-"));
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

describe("session query", () => {
	it("searches sessions with filters, bounded snippets, stable citations, and cursors", async () => {
		const root = await tempSessionsRoot();
		await writeSession(root, "s1", [
			header("s1"),
			record({ type: "operation_started", id: "run-1", seq: 1, sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } }),
			entry({ type: "message", id: "u1", seq: 2, parentId: null, message: { role: "user", content: "find the crimson widget", timestamp: 1 } }),
			entry({ type: "message", id: "a1", seq: 3, parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "crimson" } }], stopReason: "toolUse", timestamp: 2 } }),
			record({ type: "tool_started", id: "tool-1", seq: 4, runId: "run-1", assistantEntryId: "a1", toolIndex: 0, toolCallId: "call-1", toolName: "lookup", effectiveArgs: { q: "crimson" }, resultEntryId: "t1", replay: "safe" }),
			entry({ type: "message", id: "t1", seq: 5, parentId: "a1", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "crimson result" }], isError: false, timestamp: 3 } }),
			record({ type: "operation_finished", id: "done-1", seq: 6, runId: "run-1", outcome: "completed" }),
		]);
		await writeSession(root, "s2", [
			header("s2", { cwd: "/other" }),
			entry({ type: "custom", id: "intent-1", seq: 1, parentId: null, customType: "extension/intent-scheduled", data: { intentId: "i1", sessionId: "s2", extensionId: "ext-1", revisionId: "rev-1", sourceHash: "sha", runId: "run-2", toolCallId: "call-2", requestedAction: "run" } }),
		]);

		const firstPage = await searchSessionEvents(root, {
			text: "crimson",
			limit: 1,
			maxSnippetLength: 18,
			filters: { sessionId: "s1", cwd: "/work/s1", eventSurface: "current" },
		});
		expect(firstPage.results).toEqual([
			expect.objectContaining({
				sessionId: "s1",
				event: expect.objectContaining({ seq: 2, role: "user", surface: "current" }),
				citation: { sessionId: "s1", seq: 2, line: 3 },
				snippet: expect.stringMatching(/^find the crimson/),
			}),
		]);
		expect(firstPage.cursor).toEqual(expect.any(String));

		const secondPage = await searchSessionEvents(root, {
			text: "crimson",
			limit: 1,
			cursor: firstPage.cursor,
			filters: { sessionId: "s1", cwd: "/work/s1", eventSurface: "current" },
		});
		expect(secondPage.results.map((result) => result.event.seq)).toEqual([3]);
		await expect(searchSessionEvents(root, { text: "different", limit: 1, cursor: firstPage.cursor })).rejects.toMatchObject({
			code: "SESSION_QUERY_INVALID_CURSOR",
		});

		await expect(searchSessionEvents(root, { text: "", limit: 1 })).rejects.toMatchObject({
			code: "SESSION_QUERY_INVALID_QUERY",
		});
		await expect(searchSessionEvents(root, { text: "x", limit: 0 })).rejects.toMatchObject({
			code: "SESSION_QUERY_INVALID_LIMIT",
		});
		await expect(searchSessionEvents(root, { text: "x", cursor: "bad" })).rejects.toMatchObject({
			code: "SESSION_QUERY_INVALID_CURSOR",
		});
		await expect(searchSessionEvents(root, { text: "x".repeat(4_097) })).rejects.toMatchObject({
			code: "SESSION_QUERY_INVALID_QUERY",
		});
	});

	it("classifies current, shadowed, and log-only surfaces and reads bounded windows", async () => {
		const root = await tempSessionsRoot();
		await writeSession(root, "compact", [
			header("compact"),
			entry({ type: "message", id: "u1", seq: 1, parentId: null, message: { role: "user", content: "old", timestamp: 1 } }),
			entry({ type: "message", id: "u2", seq: 2, parentId: "u1", message: { role: "user", content: "middle", timestamp: 2 } }),
			entry({ type: "message", id: "u3", seq: 3, parentId: "u2", message: { role: "user", content: "tail", timestamp: 3 } }),
			entry({ type: "compaction", id: "c1", seq: 4, parentId: "u3", summary: "short", retainedTail: [], tokensBefore: 100, details: { shadowedEntryIds: ["u1", "u2"], cutEntryId: "u3", retainedEntryIds: ["u3"] } }),
			record({ type: "operation_finished", id: "done", seq: 5, runId: "run-1", outcome: "completed" }),
			{ kind: "lane", seq: 6, lane: "main", leafId: "c1" },
		]);

		const window = await getSessionEventWindow(root, "compact", 3, { before: 2, after: 2 });

		expect(window.bounds).toEqual({ startSeq: 1, endSeq: 5, before: 2, after: 2 });
		expect(window.events.map((event) => [event.seq, event.surface])).toEqual([
			[1, "shadowed"],
			[2, "shadowed"],
			[3, "current"],
			[4, "current"],
			[5, "log-only"],
		]);
		await expect(getSessionEventWindow(root, "compact", 3, { before: -1 })).rejects.toMatchObject({
			code: "SESSION_QUERY_INVALID_WINDOW",
		});
	});

	it("traces direct causal relationships and rejects contradictory compaction metadata", async () => {
		const root = await tempSessionsRoot();
		await writeSession(root, "trace", [
			header("trace"),
			record({ type: "operation_started", id: "run-1", seq: 1, sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [] } }),
			entry({ type: "message", id: "u1", seq: 2, parentId: null, message: { role: "user", content: "old", timestamp: 1 } }),
			entry({ type: "message", id: "a1", seq: 3, parentId: "u1", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }], stopReason: "toolUse", timestamp: 2 } }),
			record({ type: "tool_started", id: "tool-1", seq: 4, runId: "run-1", assistantEntryId: "a1", toolIndex: 0, toolCallId: "call-1", toolName: "lookup", effectiveArgs: {}, resultEntryId: "t1", replay: "safe" }),
			entry({ type: "message", id: "t1", seq: 5, parentId: "a1", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 } }),
			entry({ type: "compaction", id: "c1", seq: 6, parentId: "t1", summary: "short", retainedTail: [], tokensBefore: 10, details: { shadowedEntryIds: ["u1"], cutEntryId: "a1", retainedEntryIds: ["a1", "t1"] } }),
			entry({ type: "custom", id: "intent-1", seq: 7, parentId: "c1", customType: "extension/intent-scheduled", data: { intentId: "i1", sessionId: "trace", extensionId: "ext-1", revisionId: "rev-1", sourceHash: "sha", runId: "run-1", toolCallId: "call-1", requestedAction: "run" } }),
			entry({ type: "custom", id: "started-1", seq: 8, parentId: "intent-1", customType: "extension/started", data: { extensionId: "ext-1", revisionId: "rev-1", sourceHash: "sha", intentId: "i1" } }),
		]);

		const toolTrace = await traceSessionEvent(root, "trace", 4);
		expect(toolTrace.relationships).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "run", target: expect.objectContaining({ seq: 1 }) }),
				expect.objectContaining({ type: "tool-assistant", target: expect.objectContaining({ seq: 3 }) }),
				expect.objectContaining({ type: "tool-result", target: expect.objectContaining({ seq: 5 }) }),
				expect.objectContaining({ type: "extension-intent-tool", target: expect.objectContaining({ seq: 7 }) }),
			]),
		);

		const compactionTrace = await traceSessionEvent(root, "trace", 6);
		expect(compactionTrace.relationships).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "compaction-replacement", target: expect.objectContaining({ seq: 2 }) }),
				expect.objectContaining({ type: "compaction-source", target: expect.objectContaining({ seq: 3 }) }),
				expect.objectContaining({ type: "compaction-source", target: expect.objectContaining({ seq: 5 }) }),
			]),
		);
		const derivedTrace = await traceSessionEvent(root, "trace", 2);
		expect(derivedTrace.relationships).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "compaction-derived", target: expect.objectContaining({ seq: 6 }) })]),
		);

		await writeSession(root, "conflict", [
			header("conflict"),
			entry({ type: "message", id: "u1", seq: 1, parentId: null, message: { role: "user", content: "old", timestamp: 1 } }),
			entry({ type: "compaction", id: "bad", seq: 2, parentId: "u1", summary: "bad", retainedTail: [], tokensBefore: 10, details: { shadowedEntryIds: ["u1"], retainedEntryIds: ["u1"] } }),
		]);
		await expect(traceSessionEvent(root, "conflict", 2)).rejects.toMatchObject({
			code: "SESSION_QUERY_SOURCE_CONFLICT",
		});
	});

	it("reports malformed and uncommitted-tail logs without repairing files", async () => {
		const root = await tempSessionsRoot();
		await writeSession(root, "tail", [
			header("tail"),
			entry({ type: "message", id: "u1", seq: 1, parentId: null, message: { role: "user", content: "durable", timestamp: 1 } }),
		], "\n{\"kind\":\"entry\"");
		const malformedPath = await writeSession(root, "bad", [
			header("bad"),
			entry({ type: "message", id: "u1", seq: 1, parentId: null, message: { role: "user", content: "before", timestamp: 1 } }),
		], "\n{\"kind\":\"entry\"}\n");

		const result = await searchSessionEvents(root, { text: "durable", filters: { corruptionState: "uncommitted-tail" } });
		expect(result.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "tail", corruptionState: "uncommitted-tail" })]));
		expect((await searchSessionEvents(root, { text: "before", filters: { corruptionState: "malformed" } })).sessions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "bad", corruptionState: "malformed" })]),
		);
		await expect(readFile(sessionLockPath(malformedPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("returns ancestors, descendants, and unresolved parents from discovered headers", async () => {
		const root = await tempSessionsRoot();
		await writeSession(root, "root", [header("root")]);
		await writeSession(root, "child", [header("child", { parentSessionId: "root" })]);
		await writeSession(root, "grandchild", [header("grandchild", { parentSessionId: "child" })]);
		await writeSession(root, "orphan", [header("orphan", { parentSessionId: "missing" })]);

		expect(await getSessionLineage(root, "child")).toMatchObject({
			sessionId: "child",
			ancestors: [{ sessionId: "root", resolved: true }],
			descendants: [
				{ sessionId: "grandchild", parentSessionId: "child", depth: 1 },
			],
			unresolvedParents: [],
		});
		expect(await getSessionLineage(root, "orphan")).toMatchObject({
			ancestors: [{ sessionId: "missing", resolved: false }],
			unresolvedParents: ["missing"],
		});
	});

	it("exposes stable SESSION_QUERY errors", () => {
		expect(new SessionQueryError("SESSION_QUERY_NOT_FOUND", "missing")).toMatchObject({
			code: "SESSION_QUERY_NOT_FOUND",
			message: "missing",
		});
	});
});
