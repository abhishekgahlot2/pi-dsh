// Dependency-free local HTTP/SSE server for the Stage 7 read-only trajectory UI.
// API handlers derive paths only from discovered session ids and use direct
// read-only JSONL decoding rather than writable session storage.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getSessionEventWindow,
	getSessionLineage,
	searchSessionEvents,
	SessionQueryError,
	traceSessionEvent as traceSessionQueryEvent,
	type SessionEventSurface,
} from "../src/session-query.ts";
import {
	discoverSessionSummaries,
	isSafeSessionId,
	readSessionLogFile,
} from "./session-log.ts";

export interface TrajectoryServerOptions {
	sessionsRoot?: string;
	staticRoot?: string;
	host?: string;
	port?: number;
	allowRemote?: boolean;
}

export interface TrajectoryServer {
	server: Server;
	url: string;
	sessionsRoot: string;
	staticRoot: string;
	close(): Promise<void>;
}

interface ServerState {
	readonly sessionsRoot: string;
	readonly staticRoot: string;
	readonly sseClients: Set<SseClient>;
}

interface SseClient {
	readonly response: ServerResponse;
	readonly close: () => void;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_STATIC_ROOT = fileURLToPath(new URL("./app", import.meta.url));
const HARDENING_HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Referrer-Policy": "no-referrer",
};

export function createTrajectoryHttpServer(options: TrajectoryServerOptions = {}): Server {
	const state: ServerState = {
		sessionsRoot: resolve(options.sessionsRoot ?? process.env.PIDSH_SESSIONS_ROOT ?? ".pi-dsh/sessions"),
		staticRoot: resolve(options.staticRoot ?? DEFAULT_STATIC_ROOT),
		sseClients: new Set(),
	};
	const server = createServer((request, response) => {
		void handleRequest(state, request, response);
	});
	const close = server.close.bind(server);
	server.close = ((callback?: (error?: Error) => void): Server => {
		for (const client of [...state.sseClients]) client.close();
		return close(callback);
	}) as Server["close"];
	server.on("close", () => {
		for (const client of state.sseClients) client.close();
		state.sseClients.clear();
	});
	return server;
}

export async function startTrajectoryServer(options: TrajectoryServerOptions = {}): Promise<TrajectoryServer> {
	const host = options.host ?? DEFAULT_HOST;
	if (!isLoopbackHost(host) && options.allowRemote !== true) {
		throw new Error("Refusing non-loopback viewer host without --allow-remote; the viewer has no authentication");
	}
	const port = options.port ?? DEFAULT_PORT;
	const sessionsRoot = resolve(options.sessionsRoot ?? process.env.PIDSH_SESSIONS_ROOT ?? ".pi-dsh/sessions");
	const staticRoot = resolve(options.staticRoot ?? DEFAULT_STATIC_ROOT);
	const server = createTrajectoryHttpServer({ ...options, host, port, sessionsRoot, staticRoot });
	await new Promise<void>((resolveListen, rejectListen) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			rejectListen(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolveListen();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
	return {
		server,
		url: localServerUrl(server, host),
		sessionsRoot,
		staticRoot,
		close: () => closeServer(server),
	};
}

async function handleRequest(state: ServerState, request: IncomingMessage, response: ServerResponse): Promise<void> {
	try {
		const method = request.method ?? "GET";
		if (method !== "GET" && method !== "HEAD") {
			sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
			return;
		}
		const rawPathname = (request.url ?? "/").split("?", 1)[0] ?? "/";
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/api/sessions") {
			const sessions = await discoverSessionSummaries(state.sessionsRoot);
			sendJson(response, 200, { sessions }, {}, method === "HEAD");
			return;
		}
		if (requestUrl.pathname === "/api/query/search") {
			const parsed = parseSearchQuery(requestUrl);
			if ("error" in parsed) {
				sendJson(response, 400, { error: parsed.error });
				return;
			}
			const results = await searchSessionEvents(state.sessionsRoot, {
				text: parsed.query,
				limit: parsed.limit,
				filters: { sessionId: parsed.sessionId, eventSurface: parsed.surface },
			});
			sendJson(response, 200, { query: parsed.query, ...results }, {}, method === "HEAD");
			return;
		}
		const sessionRoute = parseSessionRoute(rawPathname);
		if (sessionRoute !== undefined) {
			const decoded = decodeRouteId(sessionRoute.encodedId);
			if (decoded === undefined || !isSafeSessionId(decoded)) {
				sendJson(response, 400, { error: "invalid_session_id" });
				return;
			}
			const sessions = await discoverSessionSummaries(state.sessionsRoot);
			if (!sessions.some((summary) => summary.id === decoded)) {
				sendJson(response, 404, { error: "session_not_found" });
				return;
			}
			const path = join(state.sessionsRoot, `${decoded}.jsonl`);
			if (sessionRoute.kind === "sse") {
				if (method === "HEAD") {
					writeHeaders(response, 200, { "Content-Type": "text/event-stream" });
					response.end();
					return;
				}
				openSse(state, request, response, path);
				return;
			}
			if (sessionRoute.kind === "lineage") {
				const lineage = await getSessionLineage(state.sessionsRoot, decoded);
				sendJson(response, 200, {
					...lineage,
					lineage: [
						{ id: decoded, parentSessionId: lineage.ancestors[0]?.sessionId, state: "current", citation: { line: 1 } },
						...lineage.ancestors.map((item) => ({ id: item.sessionId, parentSessionId: item.parentSessionId, state: item.resolved ? "available" : "unresolved", citation: item.citation })),
						...lineage.descendants.map((item) => ({ id: item.sessionId, parentSessionId: item.parentSessionId, state: "descendant", citation: item.citation })),
					],
				}, {}, method === "HEAD");
				return;
			}
			if (sessionRoute.kind === "window") {
				const window = await getSessionEventWindow(state.sessionsRoot, decoded, sessionRoute.seq, {
					before: integerQuery(requestUrl, "before", 5, 0, 100),
					after: integerQuery(requestUrl, "after", 5, 0, 100),
				});
				sendJson(response, 200, { sessionId: decoded, centerSeq: sessionRoute.seq, ...window.bounds, events: window.events }, {}, method === "HEAD");
				return;
			}
			if (sessionRoute.kind === "trace") {
				const trace = await traceSessionQueryEvent(state.sessionsRoot, decoded, sessionRoute.seq);
				const center = {
					...trace.target,
					replacesSeqs: trace.relationships.filter((relationship) => relationship.type === "compaction-replacement").map((relationship) => relationship.target.seq),
					sourceSeqs: trace.relationships.filter((relationship) => relationship.type === "compaction-source").map((relationship) => relationship.target.seq),
					derivedSeqs: trace.relationships.filter((relationship) => relationship.type === "compaction-derived").map((relationship) => relationship.target.seq),
				};
				const events = [center, ...trace.relationships.map((relationship) => relationship.target)]
					.filter((event, index, all) => all.findIndex((candidate) => candidate.seq === event.seq) === index)
					.toSorted((left, right) => left.seq - right.seq);
				sendJson(response, 200, { sessionId: decoded, center, events, relationships: trace.relationships }, {}, method === "HEAD");
				return;
			}
			const session = await readSessionLogFile(path, { fallbackId: decoded });
			sendJson(response, 200, session, {}, method === "HEAD");
			return;
		}
		await serveStatic(state.staticRoot, requestUrl.pathname, response, method === "HEAD");
	} catch (error) {
		if (error instanceof SessionQueryError) {
			sendJson(response, error.code === "SESSION_QUERY_NOT_FOUND" ? 404 : 400, { error: error.code, message: error.message });
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		sendJson(response, 500, { error: "internal_error", message });
	}
}

type SessionRoute =
	| { encodedId: string; kind: "detail" }
	| { encodedId: string; kind: "sse" }
	| { encodedId: string; kind: "lineage" }
	| { encodedId: string; kind: "window"; seq: number }
	| { encodedId: string; kind: "trace"; seq: number };

function parseSessionRoute(pathname: string): SessionRoute | undefined {
	const parts = pathname.split("/");
	if (parts.length === 4 && parts[1] === "api" && parts[2] === "sessions" && parts[3] !== "") {
		return { encodedId: parts[3]!, kind: "detail" };
	}
	if (
		parts.length === 5 &&
		parts[1] === "api" &&
		parts[2] === "sessions" &&
		parts[3] !== "" &&
		parts[4] === "events"
	) {
		return { encodedId: parts[3]!, kind: "sse" };
	}
	if (
		parts.length === 5 &&
		parts[1] === "api" &&
		parts[2] === "sessions" &&
		parts[3] !== "" &&
		parts[4] === "lineage"
	) {
		return { encodedId: parts[3]!, kind: "lineage" };
	}
	if (
		parts.length === 7 &&
		parts[1] === "api" &&
		parts[2] === "sessions" &&
		parts[3] !== "" &&
		parts[4] === "events" &&
		parts[6] === "window"
	) {
		const seq = parseRouteSeq(parts[5]!);
		return seq === undefined ? undefined : { encodedId: parts[3]!, kind: "window", seq };
	}
	if (
		parts.length === 7 &&
		parts[1] === "api" &&
		parts[2] === "sessions" &&
		parts[3] !== "" &&
		parts[4] === "events" &&
		parts[6] === "trace"
	) {
		const seq = parseRouteSeq(parts[5]!);
		return seq === undefined ? undefined : { encodedId: parts[3]!, kind: "trace", seq };
	}
	return undefined;
}

function parseRouteSeq(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const seq = Number(raw);
	return Number.isSafeInteger(seq) ? seq : undefined;
}

function parseSearchQuery(
	requestUrl: URL,
): { query: string; sessionId?: string; surface?: SessionEventSurface; limit?: number } | { error: string } {
	const query = requestUrl.searchParams.get("q") ?? "";
	const sessionId = requestUrl.searchParams.get("session") ?? undefined;
	if (sessionId !== undefined && !isSafeSessionId(sessionId)) return { error: "invalid_session_id" };
	const surface = requestUrl.searchParams.get("surface") ?? undefined;
	if (surface !== undefined && surface !== "current" && surface !== "shadowed" && surface !== "log-only") {
		return { error: "invalid_surface" };
	}
	return {
		query,
		...(sessionId === undefined ? {} : { sessionId }),
		...(surface === undefined ? {} : { surface }),
		limit: integerQuery(requestUrl, "limit", 50, 1, 200),
	};
}

function integerQuery(requestUrl: URL, key: string, fallback: number, min: number, max: number): number {
	const value = requestUrl.searchParams.get(key);
	if (value === null || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function decodeRouteId(encoded: string): string | undefined {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
}

function openSse(state: ServerState, request: IncomingMessage, response: ServerResponse, path: string): void {
	writeHeaders(response, 200, {
		"Content-Type": "text/event-stream",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	response.flushHeaders();

	let watcher: FSWatcher | undefined;
	let readyTimer: NodeJS.Timeout | undefined;
	let changeTimer: NodeJS.Timeout | undefined;
	let poller: NodeJS.Timeout | undefined;
	let lastMtime = 0;
	let closed = false;
	readyTimer = setTimeout(() => {
		readyTimer = undefined;
		if (!closed) response.write("event: ready\ndata: {}\n\n");
	}, 25);

	const emitChange = (): void => {
		if (closed || changeTimer !== undefined) return;
		changeTimer = setTimeout(() => {
			changeTimer = undefined;
			if (!closed) response.write(`event: change\ndata: ${JSON.stringify({ changedAt: Date.now() })}\n\n`);
		}, 100);
	};
	const poll = async (): Promise<void> => {
		try {
			const fileStat = await stat(path);
			if (lastMtime === 0) lastMtime = fileStat.mtimeMs;
			else if (fileStat.mtimeMs !== lastMtime) {
				lastMtime = fileStat.mtimeMs;
				emitChange();
			}
		} catch {
			emitChange();
		}
	};
	const close = (): void => {
		if (closed) return;
		closed = true;
		if (readyTimer !== undefined) clearTimeout(readyTimer);
		if (changeTimer !== undefined) clearTimeout(changeTimer);
		if (poller !== undefined) clearInterval(poller);
		watcher?.close();
		state.sseClients.delete(client);
		if (!response.destroyed) response.end();
	};
	const client: SseClient = { response, close };
	state.sseClients.add(client);

	try {
		watcher = watch(path, { persistent: false }, emitChange);
		watcher.on("error", emitChange);
	} catch {
		emitChange();
	}
	void poll();
	poller = setInterval(() => {
		void poll();
	}, 750);
	request.on("close", close);
	response.on("close", close);
}

async function serveStatic(staticRoot: string, pathname: string, response: ServerResponse, headOnly: boolean): Promise<void> {
	const requested = pathname === "/" ? "/index.html" : pathname;
	const decoded = decodeStaticPath(requested);
	if (decoded === undefined) {
		sendText(response, 400, "bad request");
		return;
	}
	const filePath = resolve(staticRoot, `.${decoded}`);
	if (!isInside(staticRoot, filePath)) {
		sendText(response, 404, "not found");
		return;
	}
	try {
		const fileStat = await lstat(filePath);
		if (!fileStat.isFile()) {
			sendText(response, 404, "not found");
			return;
		}
		const body = await readFile(filePath);
		writeHeaders(response, 200, { "Content-Type": contentType(filePath), "Content-Length": String(body.length) });
		if (headOnly) response.end();
		else response.end(body);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			sendText(response, 404, "not found");
			return;
		}
		throw error;
	}
}

function decodeStaticPath(pathname: string): string | undefined {
	try {
		const decoded = decodeURIComponent(pathname);
		if (!decoded.startsWith("/")) return undefined;
		return normalize(decoded);
	} catch {
		return undefined;
	}
}

function isInside(root: string, child: string): boolean {
	const relation = relative(root, child);
	return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
	headOnly = false,
): void {
	const encoded = Buffer.from(JSON.stringify(body));
	writeHeaders(response, status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(encoded.length),
		...headers,
	});
	if (headOnly) response.end();
	else response.end(encoded);
}

function sendText(response: ServerResponse, status: number, body: string): void {
	const encoded = Buffer.from(body);
	writeHeaders(response, status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": String(encoded.length),
	});
	response.end(encoded);
}

function writeHeaders(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
	response.writeHead(status, { ...HARDENING_HEADERS, ...headers });
}

function contentType(path: string): string {
	switch (extname(path)) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".json":
			return "application/json; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

function localServerUrl(server: Server, host: string): string {
	const address = server.address();
	if (address === null || typeof address === "string") return `http://${host}`;
	return `http://${host}:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) rejectClose(error);
			else resolveClose();
		});
	});
}

export function parseServerArgs(args: readonly string[]): TrajectoryServerOptions {
	const options: TrajectoryServerOptions = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const readValue = (): string => {
			const value = args[index + 1];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			index += 1;
			return value;
		};
		switch (arg) {
			case "--port":
				options.port = Number(readValue());
				if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
					throw new Error("--port must be an integer from 0 to 65535");
				}
				break;
			case "--host":
				options.host = readValue();
				break;
			case "--sessions-root":
				options.sessionsRoot = readValue();
				break;
			case "--static-root":
				options.staticRoot = readValue();
				break;
			case "--allow-remote":
				options.allowRemote = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		const running = await startTrajectoryServer(parseServerArgs(process.argv.slice(2)));
		process.stdout.write(`pi-dsh trajectory viewer: ${running.url}\n`);
		process.stdout.write(`sessions: ${running.sessionsRoot}\n`);
		const shutdown = (): void => {
			void running.close().finally(() => process.exit(0));
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
