import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUEST_HEADER_TYPE } from "../src/request-snapshot.ts";
import { CONSTRAINT_ADD_TYPE } from "../src/constraints.ts";
import { sessionLockPath } from "../src/persistence.ts";
import {
	discoverSessionSummaries as listSessionSummaries,
	projectSessionLogText,
	readSessionLogFile as readSessionLog,
} from "../web/session-log.ts";
import { startTrajectoryServer } from "../web/server.ts";

type WebServer = Awaited<ReturnType<typeof startTrajectoryServer>>;
type SseState = { buffer: string };
type SseReadResult = { done: true; value?: undefined } | { done: false; value: Uint8Array };

const tempRoots: string[] = [];
const servers: WebServer[] = [];

afterEach(async () => {
	await Promise.allSettled(servers.splice(0).map((server) => server.close()));
	await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsh-web-"));
	tempRoots.push(root);
	return root;
}

async function createServer(sessionsRoot: string): Promise<WebServer> {
	const server = await startTrajectoryServer({ sessionsRoot, host: "127.0.0.1", port: 0 });
	servers.push(server);
	return server;
}

async function writeSession(root: string, id: string, lines: readonly Record<string, unknown>[]): Promise<string> {
	await mkdir(root, { recursive: true });
	const path = join(root, `${id}.jsonl`);
	await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return path;
}

function header(id: string, modifiedAt = 1_800_000_000_000): Record<string, unknown> {
	return { kind: "header", version: 4, id, createdAt: modifiedAt, cwd: `/work/${id}` };
}

function entry(fields: Record<string, unknown>): Record<string, unknown> {
	return {
		kind: "entry",
		lane: "main",
		parentId: null,
		timestamp: 1_800_000_000_000,
		...fields,
	};
}

function record(fields: Record<string, unknown>): Record<string, unknown> {
	return {
		kind: "record",
		lane: "main",
		timestamp: 1_800_000_000_000,
		...fields,
	};
}

async function fetchJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	expect(response.headers.get("cache-control")).toContain("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	return response.json();
}

async function nextSseEvent(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	state: SseState,
	timeoutMs = 1_000,
): Promise<{ event: string; data: string }> {
	const decoder = new TextDecoder();
	const deadline = setTimeout(() => undefined, timeoutMs);
	try {
		while (true) {
			const boundary = state.buffer.indexOf("\n\n");
			if (boundary >= 0) {
				const raw = state.buffer.slice(0, boundary);
				state.buffer = state.buffer.slice(boundary + 2);
				const lines = raw.split("\n");
				return {
					event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "message",
					data: lines
						.filter((line) => line.startsWith("data: "))
						.map((line) => line.slice("data: ".length))
						.join("\n"),
				};
			}

			const read = reader.read();
			const result = await Promise.race([
				read,
				new Promise<SseReadResult>((_, reject) => {
					setTimeout(() => reject(new Error("Timed out waiting for SSE event")), timeoutMs);
				}),
			]);
			if (result.done) throw new Error("SSE stream closed before next event");
			state.buffer += decoder.decode(result.value, { stream: true });
		}
	} finally {
		clearTimeout(deadline);
	}
}

describe("readSessionLog", () => {
	it("projects valid Pi v4 mutations into stable trajectory and chat rows", async () => {
		const root = await tempRoot();
		const path = await writeSession(root, "full", [
			header("full"),
			record({
				type: "operation_started",
				id: "run-1",
				seq: 1,
				sourceLeafId: null,
				intent: { kind: "run", originalPrompt: [], initialMessages: [] },
			}),
			entry({ type: "message", id: "u1", seq: 2, message: { role: "user", content: "hello", timestamp: 1 } }),
			entry({
				type: "message",
				id: "a1",
				seq: 3,
				parentId: "u1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "x" } }],
					stopReason: "toolUse",
					timestamp: 2,
				},
			}),
			record({
				type: "tool_started",
				id: "tool-started-1",
				seq: 4,
				runId: "run-1",
				assistantEntryId: "a1",
				toolIndex: 0,
				toolCallId: "call-1",
				toolName: "lookup",
				effectiveArgs: { q: "x" },
				resultEntryId: "t1",
				replay: "safe",
			}),
			entry({
				type: "message",
				id: "t1",
				seq: 5,
				parentId: "a1",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "lookup",
					content: [{ type: "text", text: "result" }],
					details: {},
					timestamp: 3,
				},
			}),
			entry({
				type: "custom",
				id: "request-1",
				seq: 6,
				parentId: "t1",
				customType: REQUEST_HEADER_TYPE,
				data: { model: { id: "test-model", provider: "test-provider" }, constraintSection: "" },
			}),
			entry({
				type: "custom",
				id: "constraint-1",
				seq: 7,
				parentId: "request-1",
				customType: CONSTRAINT_ADD_TYPE,
				data: { id: "c1", text: "Always verify" },
			}),
			entry({
				type: "compaction",
				id: "compact-1",
				seq: 8,
				parentId: "constraint-1",
				summary: "short summary",
				retainedTail: [],
				tokensBefore: 100,
			}),
			record({
				type: "operation_finished",
				id: "repair-finished-1",
				seq: 9,
				runId: "run-1",
				outcome: "aborted",
				error: { code: "INTERRUPTED", message: "repaired on open" },
			}),
			record({ type: "usage", id: "usage-1", seq: 10, cause: "assistant", runId: "run-1", entryId: "a1", attempt: 1, stopReason: "toolUse", usage: { totalTokens: 42 } }),
			{ kind: "lane", seq: 11, lane: "main", leafId: "compact-1" },
			{ kind: "fact", seq: 12, fact: "name", name: "demo" },
		]);

		const projection = await readSessionLog(path);

		expect(projection.header).toMatchObject({ id: "full", cwd: "/work/full", version: 4 });
		expect(projection.issues).toEqual([]);
		expect(projection.uncommittedTail).toBeUndefined();
		expect(projection.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(projection.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ seq: 1, kind: "record", category: "operation", label: "operation_started" }),
				expect.objectContaining({ seq: 2, kind: "entry", category: "user", label: "user message", role: "user" }),
				expect.objectContaining({ seq: 3, kind: "entry", category: "assistant", label: "assistant message", role: "assistant" }),
				expect.objectContaining({ seq: 4, kind: "record", category: "tool", label: "tool_started" }),
				expect.objectContaining({ seq: 5, kind: "entry", category: "tool", label: "toolResult message", role: "toolResult", toolCallId: "call-1" }),
				expect.objectContaining({
					seq: 6,
					kind: "entry",
					category: "request",
					label: REQUEST_HEADER_TYPE,
					summary: "Provider request test-provider/test-model",
				}),
				expect.objectContaining({ seq: 7, kind: "entry", category: "constraint", label: CONSTRAINT_ADD_TYPE }),
				expect.objectContaining({ seq: 8, kind: "entry", category: "compaction", label: "compaction" }),
				expect.objectContaining({ seq: 9, kind: "record", category: "repair", label: "operation_finished" }),
				expect.objectContaining({ seq: 10, kind: "record", category: "usage", label: "usage" }),
				expect.objectContaining({ seq: 11, kind: "lane", category: "storage", label: "lane main" }),
				expect.objectContaining({ seq: 12, kind: "fact", category: "storage", label: "session name" }),
			]),
		);
		expect(projection.chat.map((row) => row.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(projection.chat.at(2)).toMatchObject({ entryId: "t1", toolCallId: "call-1" });
	});

	it("returns a parse error for malformed interior lines without throwing", async () => {
		const root = await tempRoot();
		const path = join(root, "bad.jsonl");
		await writeFile(
			path,
			[
				JSON.stringify(header("bad")),
				JSON.stringify(entry({ type: "message", id: "u1", seq: 1, message: { role: "user", content: "before", timestamp: 1 } })),
				"{",
				JSON.stringify(entry({ type: "message", id: "u2", seq: 2, message: { role: "user", content: "after", timestamp: 2 } })),
				"",
			].join("\n"),
		);

		const projection = await readSessionLog(path);

		expect(projection.header).toMatchObject({ id: "bad" });
		expect(projection.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: "u1" })]));
		expect(projection.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "u2" })]));
		expect(projection.issues).toEqual([expect.objectContaining({ line: 3 })]);
		expect(projection.summary).toMatchObject({ corruptionState: "malformed" });
	});

	it("reports a final incomplete line as uncommitted tail and excludes it from durable events", async () => {
		const root = await tempRoot();
		const path = join(root, "tail.jsonl");
		await writeFile(
			path,
			`${JSON.stringify(header("tail"))}\n${JSON.stringify(entry({ type: "message", id: "u1", seq: 1, message: { role: "user", content: "durable", timestamp: 1 } }))}\n{"kind":"entry"`,
		);

		const projection = await readSessionLog(path);

		expect(projection.events).toEqual([expect.objectContaining({ id: "u1" })]);
		expect(projection.issues).toEqual([]);
		expect(projection.summary).toMatchObject({ corruptionState: "uncommitted-tail" });
		expect(projection.uncommittedTail).toBe("{\"kind\":\"entry\"");
	});

	it("treats a final syntax-torn line as uncommitted even when newline terminated", () => {
		const projection = projectSessionLogText(`${JSON.stringify(header("tail-newline"))}\n{\n`, {
			fallbackId: "tail-newline",
		});

		expect(projection.events).toEqual([]);
		expect(projection.issues).toEqual([]);
		expect(projection.summary.corruptionState).toBe("uncommitted-tail");
		expect(projection.uncommittedTail).toBe("{");
	});
});

describe("trajectory HTTP server", () => {
	it("discovers summaries without crashing on malformed headers", async () => {
		const root = await tempRoot();
		const cleanPath = await writeSession(root, "clean", [header("clean")]);
		const badHeaderPath = join(root, "bad-header.jsonl");
		await writeFile(badHeaderPath, `${JSON.stringify({ kind: "not-header", id: "ignored" })}\n`);

		const summaries = await listSessionSummaries(root);

		expect(summaries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "clean", sizeBytes: (await stat(cleanPath)).size, corruptionState: "clean" }),
				expect.objectContaining({ id: "bad-header", sizeBytes: (await stat(badHeaderPath)).size, corruptionState: "malformed" }),
			]),
		);
	});

	it("lists sessions sorted by most recent modification and marks malformed sessions", async () => {
		const root = await tempRoot();
		const oldPath = await writeSession(root, "old", [header("old")]);
		const newPath = await writeSession(root, "new", [header("new")]);
		const badPath = join(root, "bad.jsonl");
		await writeFile(badPath, `${JSON.stringify(header("bad"))}\n${JSON.stringify({ kind: "entry", seq: 1 })}\n`);
		const badHeaderPath = join(root, "bad-header.jsonl");
		await writeFile(badHeaderPath, `${JSON.stringify({ kind: "not-header", id: "ignored" })}\n`);
		await writeFile(oldPath, await readFile(oldPath, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await writeFile(newPath, await readFile(newPath, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await writeFile(badPath, await readFile(badPath, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await writeFile(badHeaderPath, await readFile(badHeaderPath, "utf8"));
		const server = await createServer(root);

		const body = await fetchJson(`${server.url}/api/sessions`);

		expect(body).toEqual({
			sessions: [
				expect.objectContaining({
					id: "bad-header",
					sizeBytes: (await stat(badHeaderPath)).size,
					corruptionState: "malformed",
					error: expect.any(String),
				}),
				expect.objectContaining({ id: "bad", corruptionState: "malformed", error: expect.any(String) }),
				expect.objectContaining({ id: "new", cwd: "/work/new", sizeBytes: (await stat(newPath)).size, corruptionState: "clean" }),
				expect.objectContaining({ id: "old", cwd: "/work/old", sizeBytes: (await stat(oldPath)).size, corruptionState: "clean" }),
			],
		});
	});

	it("returns details only for discovered ids and rejects malformed or traversal ids", async () => {
		const root = await tempRoot();
		const path = await writeSession(root, "known", [header("known")]);
		const hiddenPath = join(root, "hidden.jsonl");
		await writeFile(hiddenPath, `${JSON.stringify(header("different-id"))}\n`);
		const server = await createServer(root);

		await expect(fetchJson(`${server.url}/api/sessions/known`)).resolves.toMatchObject({
			header: expect.objectContaining({ id: "known" }),
		});
		await expect(readFile(sessionLockPath(path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fetchJson(`${server.url}/api/sessions/hidden`)).resolves.toMatchObject({
			summary: { id: "hidden", corruptionState: "malformed", error: expect.stringContaining("does not match") },
			header: { id: "different-id" },
		});
		await expect(fetch(`${server.url}/api/sessions/different-id`)).resolves.toMatchObject({ status: 404 });
		await expect(fetch(`${server.url}/api/sessions/missing`)).resolves.toMatchObject({ status: 404 });
		await expect(fetch(`${server.url}/api/sessions/%2e%2e%2fpackage`)).resolves.toSatisfy(
			(response: Response) => response.status === 400 || response.status === 404,
		);
	});

	it("serves only bundled static assets with expected content types and landmarks", async () => {
		const root = await tempRoot();
		const server = await createServer(root);

		const shell = await fetch(`${server.url}/`);
		const html = await shell.text();
		const script = await fetch(`${server.url}/app.js`);
		const style = await fetch(`${server.url}/styles.css`);
		const missing = await fetch(`${server.url}/does-not-exist.js`);
		const traversal = await fetch(`${server.url}/%2e%2e/package.json`);

		expect(shell.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("id=\"session-list\"");
		expect(html).toContain("id=\"view-chat\"");
		expect(html).toContain("id=\"view-trajectory\"");
		expect(html).toContain("id=\"event-filters\"");
		expect(html).toContain("id=\"event-search\"");
		expect(html).toContain("id=\"event-list\"");
		expect(html).toContain("id=\"event-detail\"");
		expect(script.headers.get("content-type")).toContain("javascript");
		expect(style.headers.get("content-type")).toContain("text/css");
		expect(missing.status).toBe(404);
		expect([400, 404]).toContain(traversal.status);
		expect(await traversal.text()).not.toContain("\"name\": \"pi-dsh\"");
	});

	it("emits an initial SSE ready event and a change event after the selected log changes", async () => {
		const root = await tempRoot();
		const path = await writeSession(root, "live", [header("live")]);
		const server = await createServer(root);
		const response = await fetch(`${server.url}/api/sessions/live/events`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected SSE response body");
		const state = { buffer: "" };

		expect(response.headers.get("content-type")).toContain("text/event-stream");
		await expect(nextSseEvent(reader, state)).resolves.toMatchObject({ event: "ready" });

		await writeFile(
			path,
			`${await readFile(path, "utf8")}${JSON.stringify(entry({ type: "message", id: "u1", seq: 1, message: { role: "user", content: "live", timestamp: 1 } }))}\n`,
		);

		await expect(nextSseEvent(reader, state, 1_000)).resolves.toMatchObject({ event: "change" });
		await reader.cancel();
	});

	it("closes active SSE streams and releases the listener port", async () => {
		const root = await tempRoot();
		await writeSession(root, "close", [header("close")]);
		const server = await createServer(root);
		const response = await fetch(`${server.url}/api/sessions/close/events`);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Expected SSE response body");

		servers.splice(servers.indexOf(server), 1);
		const closePromise = server.close();
		const closeResult = await Promise.race([
			closePromise.then(() => "closed" as const),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
		]);
		if (closeResult === "timed-out") {
			await reader.cancel().catch(() => undefined);
			await closePromise.catch(() => undefined);
		}
		expect(closeResult).toBe("closed");

		await expect(
			Promise.race([
				reader.read().then((result) => result.done),
				new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("SSE stream remained open")), 1_000)),
			]),
		).resolves.toBe(true);
		await expect(fetch(server.url)).rejects.toThrow();
	});
});
