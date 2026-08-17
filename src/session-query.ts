import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseHeader, parseMutation } from "../vendor/pi/harness/session/jsonl/codec.ts";
import type { JsonlV4Header } from "../vendor/pi/harness/session/jsonl.ts";
import type { Entry, JsonValue, LaneRecord } from "../vendor/pi/harness/session/types.ts";
import type { SessionMutation } from "../vendor/pi/harness/session/state.ts";

export const SESSION_QUERY_DEFAULT_MAX_SESSIONS = 100;
export const SESSION_QUERY_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const SESSION_QUERY_DEFAULT_MAX_RESULTS = 50;
export const SESSION_QUERY_DEFAULT_MAX_SNIPPET_LENGTH = 240;
export const SESSION_QUERY_DEFAULT_WINDOW_RADIUS = 20;
const SESSION_QUERY_MAX_TEXT_LENGTH = 4_096;

export type SessionQueryCode =
	| "SESSION_QUERY_INVALID_QUERY"
	| "SESSION_QUERY_INVALID_CURSOR"
	| "SESSION_QUERY_INVALID_LIMIT"
	| "SESSION_QUERY_INVALID_WINDOW"
	| "SESSION_QUERY_INVALID_SESSION_ID"
	| "SESSION_QUERY_NOT_FOUND"
	| "SESSION_QUERY_BOUNDS_EXCEEDED"
	| "SESSION_QUERY_SOURCE_CONFLICT";

export type SessionEventSurface = "current" | "shadowed" | "log-only";
export type SessionCorruptionState = "clean" | "malformed" | "uncommitted-tail";

export interface SessionQueryCitation {
	sessionId: string;
	seq: number;
	line: number;
}

export interface SessionQueryIssue {
	line: number;
	message: string;
	raw?: string;
}

export interface SessionQuerySessionSummary {
	id: string;
	cwd?: string;
	createdAt?: number;
	modifiedAt: number;
	sizeBytes: number;
	corruptionState: SessionCorruptionState;
	error?: string;
	parentSessionId?: string;
	uncommittedTailBytes?: number;
}

export interface SessionQueryEvent {
	sessionId: string;
	seq: number;
	line: number;
	kind: SessionMutation["kind"];
	category: string;
	label: string;
	summary: string;
	surface: SessionEventSurface;
	citation: SessionQueryCitation;
	timestamp?: number;
	id?: string;
	lane?: string;
	role?: string;
	runId?: string;
	parentId?: string | null;
	toolCallId?: string;
	extensionId?: string;
	correlationId?: string;
	searchText: string;
	payload: JsonValue;
}

export interface SessionQueryLog {
	summary: SessionQuerySessionSummary;
	header?: JsonlV4Header;
	events: SessionQueryEvent[];
	issues: SessionQueryIssue[];
	uncommittedTail?: string;
}

export interface SessionSearchFilters {
	sessionId?: string;
	cwd?: string;
	category?: string;
	role?: string;
	runId?: string;
	toolCallId?: string;
	extensionId?: string;
	eventSurface?: SessionEventSurface;
	corruptionState?: SessionCorruptionState;
	parentSessionId?: string;
}

export interface SessionSearchRequest {
	text?: string;
	limit?: number;
	cursor?: string;
	maxSessions?: number;
	maxBytes?: number;
	maxResults?: number;
	maxSnippetLength?: number;
	filters?: SessionSearchFilters;
}

export interface SessionSearchResult {
	sessionId: string;
	event: SessionQueryEvent;
	citation: SessionQueryCitation;
	snippet: string;
}

export interface SessionSearchResponse {
	results: SessionSearchResult[];
	sessions: SessionQuerySessionSummary[];
	cursor?: string;
	bounds: {
		maxSessions: number;
		maxBytes: number;
		maxResults: number;
		maxSnippetLength: number;
		scannedSessions: number;
		scannedBytes: number;
		totalMatches: number;
	};
}

export interface SessionWindowResponse {
	session: SessionQuerySessionSummary;
	target: SessionQueryEvent;
	events: SessionQueryEvent[];
	bounds: { startSeq: number; endSeq: number; before: number; after: number };
}

export interface SessionTraceRelationship {
	type: string;
	direction: "incoming" | "outgoing";
	target: SessionQueryEvent;
	citation: SessionQueryCitation;
	fields: Record<string, JsonValue>;
}

export interface SessionTraceResponse {
	session: SessionQuerySessionSummary;
	target: SessionQueryEvent;
	relationships: SessionTraceRelationship[];
}

export interface SessionLineageNode {
	sessionId: string;
	parentSessionId?: string;
	depth: number;
	resolved: boolean;
	citation?: { sessionId: string; line: number };
}

export interface SessionLineageResponse {
	sessionId: string;
	ancestors: SessionLineageNode[];
	descendants: SessionLineageNode[];
	unresolvedParents: string[];
}

interface ReadSessionMeta {
	id: string;
	path: string;
	modifiedAt: number;
	sizeBytes: number;
}

interface SearchCursor {
	v: 1;
	offset: number;
	fingerprint: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CURSOR_PREFIX = "sq1:";
const ENTRY_CATEGORIES = new Map<string, string>([
	["message:user", "user"],
	["message:assistant", "assistant"],
	["message:toolResult", "tool"],
	["compaction", "compaction"],
	["branch_summary", "compaction"],
	["custom:request-header", "request"],
	["custom:constraint/add", "constraint"],
	["custom:constraint/revoke", "constraint"],
]);

export class SessionQueryError extends Error {
	readonly code: SessionQueryCode;

	constructor(code: SessionQueryCode, message: string) {
		super(message);
		this.name = "SessionQueryError";
		this.code = code;
	}
}

export async function searchSessionEvents(
	sessionsRoot: string,
	request: SessionSearchRequest,
): Promise<SessionSearchResponse> {
	const bounds = normalizeSearchBounds(request);
	const text = request.text?.trim().toLowerCase();
	if (!text && request.cursor === undefined) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_QUERY", "search text must be non-empty");
	}
	if ((text?.length ?? 0) > SESSION_QUERY_MAX_TEXT_LENGTH) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_QUERY", `search text exceeds ${SESSION_QUERY_MAX_TEXT_LENGTH} characters`);
	}
	const fingerprint = JSON.stringify({ text, filters: request.filters ?? {}, limit: bounds.limit });
	const cursor = request.cursor === undefined ? { v: 1, offset: 0, fingerprint } satisfies SearchCursor : decodeCursor(request.cursor);
	if (cursor.fingerprint !== fingerprint) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_CURSOR", "cursor does not belong to this normalized query");
	}
	const logs = await readBoundedLogs(sessionsRoot, bounds);
	const matches = logs.flatMap((log) => {
		if (!matchesSessionFilters(log.summary, request.filters)) return [];
		return log.events
			.filter((event) => matchesEventFilters(event, request.filters))
			.filter((event) => text === undefined || event.searchText.includes(text))
			.map((event): SessionSearchResult => ({
				sessionId: log.summary.id,
				event,
				citation: event.citation,
				snippet: makeSnippet(event.summary, text, bounds.maxSnippetLength),
			}));
	});
	const results = matches.slice(cursor.offset, cursor.offset + bounds.limit);
	const nextOffset = cursor.offset + results.length;
	return {
		results,
		sessions: logs.map((log) => log.summary),
		...(nextOffset < matches.length ? { cursor: encodeCursor({ v: 1, offset: nextOffset, fingerprint }) } : {}),
		bounds: {
			...bounds,
			scannedSessions: logs.length,
			scannedBytes: logs.reduce((sum, log) => sum + log.summary.sizeBytes, 0),
			totalMatches: matches.length,
		},
	};
}

export async function getSessionEventWindow(
	sessionsRoot: string,
	sessionId: string,
	seq: number,
	options: { before?: number; after?: number } = {},
): Promise<SessionWindowResponse> {
	assertSessionId(sessionId);
	assertPositiveSeq(seq);
	const before = options.before ?? SESSION_QUERY_DEFAULT_WINDOW_RADIUS;
	const after = options.after ?? SESSION_QUERY_DEFAULT_WINDOW_RADIUS;
	if (!Number.isInteger(before) || before < 0 || !Number.isInteger(after) || after < 0) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_WINDOW", "window before/after must be non-negative integers");
	}
	const log = await readOneLog(sessionsRoot, sessionId);
	const target = findEventBySeq(log, seq);
	const startSeq = Math.max(1, seq - before);
	const endSeq = seq + after;
	return {
		session: log.summary,
		target,
		events: log.events.filter((event) => event.seq >= startSeq && event.seq <= endSeq),
		bounds: { startSeq, endSeq, before, after },
	};
}

export async function traceSessionEvent(
	sessionsRoot: string,
	sessionId: string,
	seq: number,
): Promise<SessionTraceResponse> {
	assertSessionId(sessionId);
	assertPositiveSeq(seq);
	const log = await readOneLog(sessionsRoot, sessionId);
	const target = findEventBySeq(log, seq);
	assertNoCompactionSourceConflicts(log);
	return {
		session: log.summary,
		target,
		relationships: relationshipsFor(log, target),
	};
}

export async function getSessionLineage(sessionsRoot: string, sessionId: string): Promise<SessionLineageResponse> {
	assertSessionId(sessionId);
	const metas = await discoverSessionFiles(sessionsRoot, {
		maxSessions: SESSION_QUERY_DEFAULT_MAX_SESSIONS,
		maxBytes: SESSION_QUERY_DEFAULT_MAX_BYTES,
	});
	const headers = new Map<string, JsonlV4Header>();
	for (const meta of metas) {
		const header = await readHeaderOnly(meta.path);
		if (header !== undefined) headers.set(meta.id, header);
	}
	if (!headers.has(sessionId)) throw new SessionQueryError("SESSION_QUERY_NOT_FOUND", `session not found: ${sessionId}`);
	const ancestors: SessionLineageNode[] = [];
	const unresolvedParents: string[] = [];
	let parentId = headers.get(sessionId)?.parentSessionId;
	let depth = 1;
	const seen = new Set<string>([sessionId]);
	while (parentId !== undefined && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = headers.get(parentId);
		const resolved = parent !== undefined;
		ancestors.push({
			sessionId: parentId,
			depth,
			resolved,
			...(parent?.parentSessionId === undefined ? {} : { parentSessionId: parent.parentSessionId }),
			...(resolved ? { citation: { sessionId: parentId, line: 1 } } : {}),
		});
		if (!resolved) {
			unresolvedParents.push(parentId);
			break;
		}
		parentId = parent.parentSessionId;
		depth++;
	}
	const descendants: SessionLineageNode[] = [];
	const frontier = [{ id: sessionId, depth: 1 }];
	for (let index = 0; index < frontier.length; index++) {
		const current = frontier[index]!;
		for (const [candidateId, header] of headers) {
			if (header.parentSessionId !== current.id) continue;
			descendants.push({
				sessionId: candidateId,
				parentSessionId: current.id,
				depth: current.depth,
				resolved: true,
				citation: { sessionId: candidateId, line: 1 },
			});
			frontier.push({ id: candidateId, depth: current.depth + 1 });
		}
	}
	return { sessionId, ancestors, descendants, unresolvedParents };
}

function normalizeSearchBounds(request: SessionSearchRequest): {
	limit: number;
	maxSessions: number;
	maxBytes: number;
	maxResults: number;
	maxSnippetLength: number;
} {
	const limit = request.limit ?? SESSION_QUERY_DEFAULT_MAX_RESULTS;
	const maxSessions = request.maxSessions ?? SESSION_QUERY_DEFAULT_MAX_SESSIONS;
	const maxBytes = request.maxBytes ?? SESSION_QUERY_DEFAULT_MAX_BYTES;
	const maxResults = request.maxResults ?? SESSION_QUERY_DEFAULT_MAX_RESULTS;
	const maxSnippetLength = request.maxSnippetLength ?? SESSION_QUERY_DEFAULT_MAX_SNIPPET_LENGTH;
	for (const [name, value] of Object.entries({ limit, maxSessions, maxBytes, maxResults, maxSnippetLength })) {
		if (!Number.isInteger(value) || value <= 0) {
			throw new SessionQueryError("SESSION_QUERY_INVALID_LIMIT", `${name} must be a positive integer`);
		}
	}
	return { limit: Math.min(limit, maxResults), maxSessions, maxBytes, maxResults, maxSnippetLength };
}

async function readBoundedLogs(
	sessionsRoot: string,
	bounds: { maxSessions: number; maxBytes: number },
): Promise<SessionQueryLog[]> {
	const files = await discoverSessionFiles(sessionsRoot, bounds);
	const logs: SessionQueryLog[] = [];
	let scannedBytes = 0;
	for (const file of files) {
		if (scannedBytes + file.sizeBytes > bounds.maxBytes) break;
		scannedBytes += file.sizeBytes;
		logs.push(await readSessionLogFile(file.path, file.id, file.modifiedAt, file.sizeBytes));
	}
	return logs;
}

async function readOneLog(sessionsRoot: string, sessionId: string): Promise<SessionQueryLog> {
	const path = join(sessionsRoot, `${sessionId}.jsonl`);
	try {
		const fileStat = await lstat(path);
		if (!fileStat.isFile()) throw new SessionQueryError("SESSION_QUERY_NOT_FOUND", `session not found: ${sessionId}`);
		if (fileStat.size > SESSION_QUERY_DEFAULT_MAX_BYTES) {
			throw new SessionQueryError("SESSION_QUERY_INVALID_LIMIT", `session ${sessionId} exceeds the bounded read limit`);
		}
		return await readSessionLogFile(path, sessionId, fileStat.mtimeMs, fileStat.size);
	} catch (error) {
		if (error instanceof SessionQueryError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new SessionQueryError("SESSION_QUERY_NOT_FOUND", `session not found: ${sessionId}`);
		}
		throw error;
	}
}

async function discoverSessionFiles(
	sessionsRoot: string,
	bounds: { maxSessions: number; maxBytes: number },
): Promise<ReadSessionMeta[]> {
	let names: string[];
	try {
		names = await readdir(sessionsRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files = await Promise.all(
		names
			.filter((name) => name.endsWith(".jsonl"))
			.map(async (name): Promise<ReadSessionMeta | undefined> => {
				const id = basename(name, ".jsonl");
				if (!SESSION_ID_PATTERN.test(id)) return undefined;
				const path = join(sessionsRoot, name);
				const fileStat = await lstat(path);
				if (!fileStat.isFile()) return undefined;
				return { id, path, modifiedAt: fileStat.mtimeMs, sizeBytes: fileStat.size };
			}),
	);
	const sorted = files
		.filter((file): file is ReadSessionMeta => file !== undefined)
		.toSorted((left, right) => right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id));
	let totalBytes = 0;
	const bounded: ReadSessionMeta[] = [];
	for (const file of sorted) {
		if (bounded.length >= bounds.maxSessions) break;
		if (totalBytes + file.sizeBytes > bounds.maxBytes) break;
		totalBytes += file.sizeBytes;
		bounded.push(file);
	}
	return bounded;
}

async function readHeaderOnly(path: string): Promise<JsonlV4Header | undefined> {
	const content = await readFile(path, "utf8");
	const [line] = content.split("\n", 1);
	if (line === undefined) return undefined;
	const parsed = parseHeader(line);
	return parsed.ok ? parsed.value : undefined;
}

async function readSessionLogFile(
	path: string,
	fallbackId: string,
	modifiedAt: number,
	sizeBytes: number,
): Promise<SessionQueryLog> {
	const contents = await readFile(path, "utf8");
	const log = projectSessionLogText(contents, { fallbackId, modifiedAt, sizeBytes });
	if (log.header !== undefined && log.header.id !== fallbackId) {
		const issue = {
			line: 1,
			message: `session id ${log.header.id} does not match file id ${fallbackId}`,
		};
		return {
			...log,
			summary: { ...log.summary, id: fallbackId, corruptionState: "malformed", error: issue.message },
			issues: [issue, ...log.issues],
		};
	}
	return log;
}

function projectSessionLogText(
	contents: string,
	options: { fallbackId: string; modifiedAt: number; sizeBytes: number },
): SessionQueryLog {
	const { durableLines, uncommittedTail: rawTail } = splitDurableLines(contents);
	let uncommittedTail = rawTail;
	const issues: SessionQueryIssue[] = [];
	let header: JsonlV4Header | undefined;
	const headerLine = durableLines[0];
	if (headerLine === undefined || headerLine.length === 0) {
		issues.push({ line: 1, message: "missing durable header" });
	} else {
		const parsed = parseHeader(headerLine);
		if (parsed.ok) header = parsed.value;
		else issues.push({ line: 1, message: parsed.error.message, raw: headerLine });
	}
	const projected: Omit<SessionQueryEvent, "surface">[] = [];
	for (const [index, rawLine] of durableLines.slice(1).entries()) {
		const line = index + 2;
		if (!rawLine.trim()) continue;
		const parsed = parseMutation(rawLine);
		if (!parsed.ok) {
			if (index === durableLines.slice(1).length - 1 && parsed.error.kind === "syntax") {
				uncommittedTail = rawLine;
				break;
			}
			issues.push({ line, message: parsed.error.message, raw: rawLine });
			break;
		}
		projected.push(projectMutation(header?.id ?? options.fallbackId, parsed.value, line));
	}
	const corruptionState =
		issues.length > 0 ? "malformed" : uncommittedTail === undefined ? "clean" : "uncommitted-tail";
	const summary: SessionQuerySessionSummary = {
		id: header?.id ?? options.fallbackId,
		cwd: header?.cwd,
		createdAt: header?.createdAt,
		modifiedAt: options.modifiedAt,
		sizeBytes: options.sizeBytes,
		corruptionState,
		...(header?.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(issues[0] === undefined ? {} : { error: issues[0].message }),
		...(uncommittedTail === undefined ? {} : { uncommittedTailBytes: Buffer.byteLength(uncommittedTail) }),
	};
	const surfaces = classifySurfaces(projected);
	return {
		summary,
		header,
		events: projected.map((event) => ({ ...event, surface: surfaces.get(event.seq) ?? "log-only" })),
		issues,
		...(uncommittedTail === undefined ? {} : { uncommittedTail }),
	};
}

function projectMutation(
	sessionId: string,
	mutation: SessionMutation,
	line: number,
): Omit<SessionQueryEvent, "surface"> {
	if (mutation.kind === "entry") return projectEntry(sessionId, mutation.entry, mutation.lane, line);
	if (mutation.kind === "record") return projectRecord(sessionId, mutation.record, line);
	const summary =
		mutation.kind === "lane"
			? `Lane ${mutation.lane} leaf ${mutation.leafId ?? "null"}`
			: mutation.fact === "name"
				? `Session name ${mutation.name ?? "cleared"}`
				: `Label for ${mutation.targetId} ${mutation.label ?? "cleared"}`;
	const id = mutation.kind === "fact" && mutation.fact === "label" ? mutation.targetId : undefined;
	return {
		sessionId,
		seq: mutation.seq,
		line,
		kind: mutation.kind,
		category: "storage",
		label: mutation.kind === "lane" ? `lane ${mutation.lane}` : `fact ${mutation.fact}`,
		summary,
		citation: { sessionId, seq: mutation.seq, line },
		...(id === undefined ? {} : { id }),
		...(mutation.kind === "lane" ? { lane: mutation.lane } : {}),
		searchText: searchable([summary, JSON.stringify(mutation)]),
		payload: jsonPayload(mutation),
	};
}

function projectEntry(
	sessionId: string,
	entry: Entry,
	lane: string | undefined,
	line: number,
): Omit<SessionQueryEvent, "surface"> {
	const role = entry.type === "message" ? roleOf(entry.message) : undefined;
	const extensionId = entry.type === "custom" ? extensionIdOf(entry.data) : undefined;
	const toolCallId =
		entry.type === "message" && role === "toolResult" ? stringField(entry.message, "toolCallId") : undefined;
	const category =
		ENTRY_CATEGORIES.get(entry.type === "message" ? `message:${role}` : entry.type === "custom" ? `custom:${entry.customType}` : entry.type) ??
		(entry.type === "custom" && entry.customType.startsWith("extension/") ? "extension" : "record");
	const label = entry.type === "custom" ? entry.customType : entry.type === "message" ? `${role} message` : entry.type;
	const summary = summarizeEntry(entry);
	return {
		sessionId,
		seq: entry.seq,
		line,
		kind: "entry",
		category,
		label,
		summary,
		citation: { sessionId, seq: entry.seq, line },
		timestamp: entry.timestamp,
		id: entry.id,
		...(lane === undefined ? {} : { lane }),
		...(role === undefined ? {} : { role }),
		parentId: entry.parentId,
		...(toolCallId === undefined ? {} : { toolCallId, correlationId: toolCallId }),
		...(extensionId === undefined ? {} : { extensionId }),
		searchText: searchable([label, summary, entry.id, role, toolCallId, extensionId, JSON.stringify(entry)]),
		payload: jsonPayload(entry),
	};
}

function projectRecord(sessionId: string, record: LaneRecord, line: number): Omit<SessionQueryEvent, "surface"> {
	const runId = record.type === "operation_started" ? record.id : stringField(record, "runId");
	const toolCallId = stringField(record, "toolCallId");
	const summary = summarizeRecord(record);
	return {
		sessionId,
		seq: record.seq,
		line,
		kind: "record",
		category: recordCategory(record),
		label: record.type,
		summary,
		citation: { sessionId, seq: record.seq, line },
		timestamp: record.timestamp,
		id: record.id,
		lane: record.lane,
		...(runId === undefined ? {} : { runId }),
		...(toolCallId === undefined ? {} : { toolCallId }),
		correlationId: toolCallId ?? runId,
		searchText: searchable([record.type, summary, record.id, runId, toolCallId, JSON.stringify(record)]),
		payload: jsonPayload(record),
	};
}

function classifySurfaces(events: readonly Omit<SessionQueryEvent, "surface">[]): Map<number, SessionEventSurface> {
	const entriesById = new Map<string, Omit<SessionQueryEvent, "surface">>();
	let mainLeafId: string | null = null;
	for (const event of events) {
		if (event.kind === "entry" && event.id !== undefined) {
			entriesById.set(event.id, event);
			if (event.lane === "main") mainLeafId = event.id;
		}
		if (event.kind === "lane" && event.lane === "main") {
			mainLeafId = stringOrNull((event.payload as { leafId?: unknown }).leafId);
		}
	}
	const currentIds = new Set<string>();
	let cursor = mainLeafId;
	while (cursor !== null) {
		const event = entriesById.get(cursor);
		if (event === undefined) break;
		currentIds.add(cursor);
		cursor = event.parentId ?? null;
	}
	const shadowedIds = new Set<string>();
	for (const event of events) {
		if (event.kind !== "entry" || event.payload === null || typeof event.payload !== "object") continue;
		if ((event.payload as { type?: unknown }).type !== "compaction") continue;
		for (const id of stringArrayField((event.payload as { details?: unknown }).details, "shadowedEntryIds")) shadowedIds.add(id);
	}
	const surfaces = new Map<number, SessionEventSurface>();
	for (const event of events) {
		if (event.kind !== "entry" || event.id === undefined) {
			surfaces.set(event.seq, "log-only");
		} else if (shadowedIds.has(event.id)) {
			surfaces.set(event.seq, "shadowed");
		} else if (currentIds.has(event.id)) {
			surfaces.set(event.seq, "current");
		} else {
			surfaces.set(event.seq, "log-only");
		}
	}
	return surfaces;
}

function relationshipsFor(log: SessionQueryLog, target: SessionQueryEvent): SessionTraceRelationship[] {
	const relationships: SessionTraceRelationship[] = [];
	const byId = new Map(log.events.flatMap((event) => (event.id === undefined ? [] : [[event.id, event] as const])));
	const operationStartsByRunId = new Map(
		log.events.flatMap((event) => (event.label === "operation_started" && event.id !== undefined ? [[event.id, event] as const] : [])),
	);
	const toolRecords = log.events.filter((event) => event.label === "tool_started");
	const add = (type: string, direction: "incoming" | "outgoing", event: SessionQueryEvent | undefined, fields: Record<string, JsonValue> = {}) => {
		if (event === undefined || event.seq === target.seq) return;
		relationships.push({ type, direction, target: event, citation: event.citation, fields });
	};

	if (target.kind === "entry") {
		add("entry-parent", "outgoing", target.parentId === undefined || target.parentId === null ? undefined : byId.get(target.parentId));
		for (const child of log.events.filter((event) => event.parentId === target.id)) add("entry-child", "incoming", child);
	}
	if (target.runId !== undefined) {
		add("run", target.label === "operation_started" ? "incoming" : "outgoing", operationStartsByRunId.get(target.runId), { runId: target.runId });
	}
	if (target.label === "operation_started" && target.id !== undefined) {
		for (const event of log.events.filter((candidate) => candidate.runId === target.id)) add("run-member", "incoming", event, { runId: target.id });
	}
	if (target.label === "tool_started") {
		const record = target.payload as { assistantEntryId?: unknown; resultEntryId?: unknown; toolCallId?: unknown };
		add("tool-assistant", "outgoing", typeof record.assistantEntryId === "string" ? byId.get(record.assistantEntryId) : undefined);
		add("tool-result", "outgoing", typeof record.resultEntryId === "string" ? byId.get(record.resultEntryId) : undefined);
	}
	for (const tool of toolRecords) {
		const payload = tool.payload as { assistantEntryId?: unknown; resultEntryId?: unknown; toolCallId?: unknown };
		if (payload.assistantEntryId === target.id) add("tool-start", "incoming", tool);
		if (payload.resultEntryId === target.id || (target.toolCallId !== undefined && payload.toolCallId === target.toolCallId)) {
			add("tool-start", "outgoing", tool);
		}
	}
	addQueueRelationships(log, target, byId, add);
	addCompactionRelationships(log, target, byId, add);
	addExtensionRelationships(log, target, add);
	return relationships.toSorted((left, right) => left.target.seq - right.target.seq || left.type.localeCompare(right.type));
}

function addQueueRelationships(
	log: SessionQueryLog,
	target: SessionQueryEvent,
	byId: ReadonlyMap<string, SessionQueryEvent>,
	add: (type: string, direction: "incoming" | "outgoing", event: SessionQueryEvent | undefined, fields?: Record<string, JsonValue>) => void,
): void {
	for (const event of log.events) {
		if (event.label === "queue_enqueued") {
			const targetId = stringField((event.payload as { target?: unknown }).target, "id");
			if (target.seq === event.seq) add("queue-target", "outgoing", targetId === undefined ? undefined : byId.get(targetId));
			if (target.id === targetId) add("queue-enqueued", "incoming", event);
		}
		if (event.label === "queue_cancelled") {
			const entryId = stringField(event.payload, "entryId");
			if (target.seq === event.seq) add("queue-target", "outgoing", entryId === undefined ? undefined : byId.get(entryId));
			if (target.id === entryId) add("queue-cancelled", "incoming", event);
		}
	}
}

function addCompactionRelationships(
	log: SessionQueryLog,
	target: SessionQueryEvent,
	byId: ReadonlyMap<string, SessionQueryEvent>,
	add: (type: string, direction: "incoming" | "outgoing", event: SessionQueryEvent | undefined, fields?: Record<string, JsonValue>) => void,
): void {
	for (const compaction of log.events.filter((event) => event.label === "compaction")) {
		const details = (compaction.payload as { details?: unknown }).details;
		const shadowedIds = stringArrayField(details, "shadowedEntryIds");
		const sourceIds = [
			...stringArrayField(details, "retainedEntryIds"),
			...stringArrayField(details, "sourceEntryIds"),
			...stringArrayField(details, "derivedFromEntryIds"),
			...optionalStringField(details, "cutEntryId"),
		];
		if (target.seq === compaction.seq) {
			for (const id of shadowedIds) add("compaction-replacement", "outgoing", byId.get(id), { entryId: id });
			for (const id of sourceIds) add("compaction-source", "outgoing", byId.get(id), { entryId: id });
		} else if (target.id !== undefined && (shadowedIds.includes(target.id) || sourceIds.includes(target.id))) {
			add("compaction-derived", "incoming", compaction, { entryId: target.id });
		}
	}
}

function addExtensionRelationships(
	log: SessionQueryLog,
	target: SessionQueryEvent,
	add: (type: string, direction: "incoming" | "outgoing", event: SessionQueryEvent | undefined, fields?: Record<string, JsonValue>) => void,
): void {
	const intentData = extensionIntentData(target);
	if (intentData !== undefined) {
		add("extension-intent-run", "outgoing", log.events.find((event) => event.label === "operation_started" && event.id === intentData.runId), { runId: intentData.runId });
		add("extension-intent-tool", "outgoing", log.events.find((event) => event.label === "tool_started" && event.toolCallId === intentData.toolCallId), { toolCallId: intentData.toolCallId });
		for (const lifecycle of log.events.filter((event) => isExtensionLifecycle(event) && sameExtensionLifecycle(intentData, event))) {
			add("extension-lifecycle", "incoming", lifecycle, { extensionId: intentData.extensionId });
		}
		return;
	}
	if (isExtensionLifecycle(target)) {
		const targetData = objectRecord((target.payload as { data?: unknown }).data);
		for (const intent of log.events) {
			const candidate = extensionIntentData(intent);
			if (candidate === undefined) continue;
			if (sameExtensionData(candidate, targetData)) add("extension-intent", "outgoing", intent, { extensionId: candidate.extensionId });
		}
	}
	for (const intent of log.events) {
		const candidate = extensionIntentData(intent);
		if (candidate === undefined) continue;
		if (target.label === "operation_started" && target.id === candidate.runId) add("extension-intent", "incoming", intent);
		if (target.label === "tool_started" && target.toolCallId === candidate.toolCallId) add("extension-intent-tool", "incoming", intent);
	}
}

function extensionIntentData(event: SessionQueryEvent): {
	intentId: string;
	sessionId: string;
	extensionId: string;
	revisionId?: string;
	sourceHash?: string;
	runId: string;
	toolCallId: string;
	requestedAction: string;
} | undefined {
	if (event.label !== "extension/intent-scheduled") return undefined;
	const data = objectRecord((event.payload as { data?: unknown }).data);
	if (
		typeof data.intentId !== "string" ||
		typeof data.sessionId !== "string" ||
		typeof data.extensionId !== "string" ||
		typeof data.runId !== "string" ||
		typeof data.toolCallId !== "string" ||
		typeof data.requestedAction !== "string"
	) {
		return undefined;
	}
	return {
		intentId: data.intentId,
		sessionId: data.sessionId,
		extensionId: data.extensionId,
		...(typeof data.revisionId === "string" ? { revisionId: data.revisionId } : {}),
		...(typeof data.sourceHash === "string" ? { sourceHash: data.sourceHash } : {}),
		runId: data.runId,
		toolCallId: data.toolCallId,
		requestedAction: data.requestedAction,
	};
}

function isExtensionLifecycle(event: SessionQueryEvent): boolean {
	return event.label.startsWith("extension/") && event.label !== "extension/intent-scheduled";
}

function sameExtensionLifecycle(
	intent: ReturnType<typeof extensionIntentData> extends infer T ? Exclude<T, undefined> : never,
	event: SessionQueryEvent,
): boolean {
	return sameExtensionData(intent, objectRecord((event.payload as { data?: unknown }).data));
}

function sameExtensionData(intent: Exclude<ReturnType<typeof extensionIntentData>, undefined>, data: Record<string, unknown>): boolean {
	if (data.intentId === intent.intentId) return true;
	if (data.extensionId !== intent.extensionId) return false;
	if (intent.revisionId !== undefined && data.revisionId !== intent.revisionId) return false;
	if (intent.sourceHash !== undefined && data.sourceHash !== intent.sourceHash) return false;
	return true;
}

function assertNoCompactionSourceConflicts(log: SessionQueryLog): void {
	for (const event of log.events.filter((candidate) => candidate.label === "compaction")) {
		const details = (event.payload as { details?: unknown }).details;
		const shadowed = new Set(stringArrayField(details, "shadowedEntryIds"));
		const retained = stringArrayField(details, "retainedEntryIds");
		if (retained.some((id) => shadowed.has(id))) {
			throw new SessionQueryError(
				"SESSION_QUERY_SOURCE_CONFLICT",
				`compaction ${event.id ?? event.seq} has contradictory shadowed and retained source metadata`,
			);
		}
	}
}

function findEventBySeq(log: SessionQueryLog, seq: number): SessionQueryEvent {
	const event = log.events.find((candidate) => candidate.seq === seq);
	if (event === undefined) throw new SessionQueryError("SESSION_QUERY_NOT_FOUND", `event not found: ${log.summary.id}#${seq}`);
	return event;
}

function matchesSessionFilters(summary: SessionQuerySessionSummary, filters: SessionSearchFilters | undefined): boolean {
	if (filters?.sessionId !== undefined && summary.id !== filters.sessionId) return false;
	if (filters?.cwd !== undefined && summary.cwd !== filters.cwd) return false;
	if (filters?.corruptionState !== undefined && summary.corruptionState !== filters.corruptionState) return false;
	if (filters?.parentSessionId !== undefined && summary.parentSessionId !== filters.parentSessionId) return false;
	return true;
}

function matchesEventFilters(event: SessionQueryEvent, filters: SessionSearchFilters | undefined): boolean {
	if (filters?.category !== undefined && event.category !== filters.category) return false;
	if (filters?.role !== undefined && event.role !== filters.role) return false;
	if (filters?.runId !== undefined && event.runId !== filters.runId) return false;
	if (filters?.toolCallId !== undefined && event.toolCallId !== filters.toolCallId) return false;
	if (filters?.extensionId !== undefined && event.extensionId !== filters.extensionId) return false;
	if (filters?.eventSurface !== undefined && event.surface !== filters.eventSurface) return false;
	return true;
}

function encodeCursor(cursor: SearchCursor): string {
	return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

function decodeCursor(cursor: string): SearchCursor {
	if (!cursor.startsWith(CURSOR_PREFIX)) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_CURSOR", "invalid cursor prefix");
	}
	try {
		const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as Partial<SearchCursor>;
		const offset = parsed.offset;
		if (parsed.v !== 1 || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || typeof parsed.fingerprint !== "string") {
			throw new SessionQueryError("SESSION_QUERY_INVALID_CURSOR", "invalid cursor payload");
		}
		return { v: 1, offset, fingerprint: parsed.fingerprint };
	} catch (error) {
		if (error instanceof SessionQueryError) throw error;
		throw new SessionQueryError("SESSION_QUERY_INVALID_CURSOR", "invalid cursor encoding");
	}
}

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_SESSION_ID", `invalid session id: ${sessionId}`);
	}
}

function assertPositiveSeq(seq: number): void {
	if (!Number.isInteger(seq) || seq <= 0) {
		throw new SessionQueryError("SESSION_QUERY_INVALID_WINDOW", "seq must be a positive integer");
	}
}

function splitDurableLines(contents: string): { durableLines: string[]; uncommittedTail?: string } {
	const normalized = contents.replaceAll("\r\n", "\n");
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) {
		lines.pop();
		return { durableLines: lines };
	}
	const uncommittedTail = lines.pop() ?? "";
	return { durableLines: lines, uncommittedTail };
}

function recordCategory(record: LaneRecord): string {
	switch (record.type) {
		case "operation_started":
		case "abort_requested":
		case "step_attempt":
		case "operation_finished":
			return record.type === "operation_finished" && record.error?.code === "INTERRUPTED" ? "repair" : "operation";
		case "tool_started":
			return "tool";
		case "queue_enqueued":
		case "queue_cancelled":
		case "write_deferred":
			return "queue";
		case "usage":
			return "usage";
	}
}

function summarizeEntry(entry: Entry): string {
	if (entry.type === "message") return summarizeMessage(entry.message);
	if (entry.type === "custom") return `${entry.customType}: ${clip(JSON.stringify(entry.data ?? null))}`;
	if (entry.type === "compaction") return `Compaction summary: ${clip(entry.summary)}`;
	if (entry.type === "branch_summary") return `Branch summary from ${entry.fromId}: ${clip(entry.summary)}`;
	if (entry.type === "model_change") return `Model changed to ${entry.provider}/${entry.modelId}`;
	if (entry.type === "thinking_level_change") return `Thinking level changed to ${entry.thinkingLevel}`;
	return `Active tools: ${entry.activeToolNames.join(", ") || "none"}`;
}

function summarizeRecord(record: LaneRecord): string {
	switch (record.type) {
		case "operation_started":
			return `Started ${record.intent.kind} operation ${record.id}`;
		case "operation_finished":
			return `Finished operation ${record.runId}: ${record.outcome}`;
		case "abort_requested":
			return `Abort requested for ${record.runId}`;
		case "step_attempt":
			return `${record.step} attempt ${record.attempt} -> ${record.resultEntryId}`;
		case "tool_started":
			return `Tool ${record.toolName} call ${record.toolCallId} -> ${record.resultEntryId}`;
		case "queue_enqueued":
			return `Queued ${record.queue} message`;
		case "queue_cancelled":
			return `Cancelled queued entry ${record.entryId}`;
		case "write_deferred":
			return `Deferred write for ${record.runId}`;
		case "usage":
			return `Usage ${record.cause}: ${record.usage.totalTokens} tokens`;
	}
}

function summarizeMessage(message: unknown): string {
	const role = roleOf(message);
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return clip(content);
	if (Array.isArray(content)) {
		const parts = content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part === null || typeof part !== "object") return "";
				const record = part as Record<string, unknown>;
				if (typeof record.text === "string") return record.text;
				if (record.type === "toolCall") return `tool:${String(record.name ?? "unknown")}#${String(record.id ?? "?")}`;
				return "";
			})
			.filter(Boolean);
		if (parts.length > 0) return clip(parts.join(" "));
	}
	return `${role} message`;
}

function makeSnippet(searchText: string, needle: string | undefined, maxLength: number): string {
	const collapsed = searchText.replaceAll(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	if (needle === undefined) return clip(collapsed, maxLength);
	const index = collapsed.indexOf(needle);
	const start = index <= Math.floor(maxLength / 2) ? 0 : Math.max(0, index - Math.floor(maxLength / 3));
	return clip(collapsed.slice(start), maxLength);
}

function searchable(parts: readonly unknown[]): string {
	return parts
		.filter((part) => part !== undefined && part !== null)
		.map((part) => String(part).toLowerCase())
		.join(" ");
}

function clip(value: string | undefined, maxLength = 180): string {
	if (value === undefined) return "";
	const collapsed = value.replaceAll(/\s+/g, " ").trim();
	return collapsed.length <= maxLength ? collapsed : collapsed.slice(0, maxLength);
}

function roleOf(value: unknown): string {
	return typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string"
		? (value as { role: string }).role
		: "unknown";
}

function extensionIdOf(value: unknown): string | undefined {
	const data = objectRecord(value);
	return typeof data.extensionId === "string" ? data.extensionId : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
	const record = objectRecord(value);
	return typeof record[field] === "string" ? record[field] : undefined;
}

function optionalStringField(value: unknown, field: string): string[] {
	const fieldValue = objectRecord(value)[field];
	return typeof fieldValue === "string" ? [fieldValue] : [];
}

function stringArrayField(value: unknown, field: string): string[] {
	const fieldValue = objectRecord(value)[field];
	return Array.isArray(fieldValue) && fieldValue.every((item) => typeof item === "string") ? fieldValue : [];
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonPayload(value: unknown): JsonValue {
	return structuredClone(value) as JsonValue;
}
