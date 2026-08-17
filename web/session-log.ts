// Read-only Pi v4 log projection for the Stage 7 trajectory viewer.
// The viewer decodes durable JSONL directly so it never opens writable storage
// or participates in the engine's single-writer lifecycle.
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseHeader, parseMutation } from "../vendor/pi/harness/session/jsonl/codec.ts";
import type { JsonlV4Header } from "../vendor/pi/harness/session/jsonl.ts";
import type { Entry, JsonValue, LaneRecord } from "../vendor/pi/harness/session/types.ts";
import type { SessionMutation } from "../vendor/pi/harness/session/state.ts";

export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export type TrajectoryCategory =
	| "storage"
	| "operation"
	| "request"
	| "user"
	| "assistant"
	| "tool"
	| "constraint"
	| "extension"
	| "compaction"
	| "repair"
	| "queue"
	| "usage"
	| "record";

export type EventSurface = "current" | "shadowed" | "log-only";

export interface SessionParseIssue {
	line: number;
	message: string;
	raw?: string;
}

export interface SessionSummary {
	id: string;
	cwd?: string;
	createdAt?: number;
	modifiedAt: number;
	sizeBytes: number;
	corruptionState: "clean" | "malformed" | "uncommitted-tail";
	error?: string;
	uncommittedTailBytes?: number;
}

export interface ProjectedEvent {
	seq: number;
	line: number;
	kind: SessionMutation["kind"];
	category: TrajectoryCategory;
	surface?: EventSurface;
	label: string;
	summary: string;
	timestamp?: number;
	id?: string;
	lane?: string;
	role?: string;
	runId?: string;
	parentId?: string | null;
	toolCallId?: string;
	correlationId?: string;
	replacesSeqs?: number[];
	sourceSeqs?: number[];
	derivedSeqs?: number[];
	searchText: string;
	payload: JsonValue;
}

export interface ChatProjectionItem {
	seq: number;
	entryId: string;
	role: "user" | "assistant" | "toolResult";
	summary: string;
	timestamp?: number;
	toolCallIds: string[];
	toolCallId?: string;
	isError?: boolean;
	payload: JsonValue;
}

export interface ProjectedSessionLog {
	summary: SessionSummary;
	header?: JsonlV4Header;
	events: ProjectedEvent[];
	chat: ChatProjectionItem[];
	issues: SessionParseIssue[];
	uncommittedTail?: string;
}

export function isSafeSessionId(id: string): boolean {
	return SESSION_ID_PATTERN.test(id);
}

export async function discoverSessionSummaries(sessionsRoot: string): Promise<SessionSummary[]> {
	let names: string[];
	try {
		names = await readdir(sessionsRoot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const summaries = await Promise.all(
		names
			.filter((name) => name.endsWith(".jsonl"))
			.map(async (name): Promise<SessionSummary | undefined> => {
				const id = basename(name, ".jsonl");
				if (!isSafeSessionId(id)) return undefined;
				const path = join(sessionsRoot, name);
				const fileStat = await lstat(path);
				if (!fileStat.isFile()) return undefined;
				try {
					const projected = await readSessionLogFile(path, { fallbackId: id });
					return {
						...projected.summary,
						modifiedAt: fileStat.mtimeMs,
						sizeBytes: fileStat.size,
					};
				} catch (error) {
					return {
						id,
						modifiedAt: fileStat.mtimeMs,
						sizeBytes: fileStat.size,
						corruptionState: "malformed",
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
	);
	return summaries
		.filter((summary): summary is SessionSummary => summary !== undefined)
		.toSorted((left, right) => right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id));
}

export async function readSessionLogFile(
	path: string,
	options: { fallbackId?: string } = {},
): Promise<ProjectedSessionLog> {
	const fileStat = await lstat(path);
	if (!fileStat.isFile()) throw new Error(`Session path is not a regular file: ${path}`);
	const contents = await readFile(path, "utf8");
	const fileId = options.fallbackId ?? basename(path, ".jsonl");
	const projected = projectSessionLogText(contents, {
		fallbackId: fileId,
		modifiedAt: fileStat.mtimeMs,
		sizeBytes: fileStat.size,
	});
	if (projected.header !== undefined && projected.header.id !== fileId) {
		const issue = {
			line: 1,
			message: `session id ${projected.header.id} does not match file id ${fileId}`,
		};
		projected.summary = {
			...projected.summary,
			id: fileId,
			corruptionState: "malformed",
			error: issue.message,
		};
		projected.issues = [issue, ...projected.issues];
	}
	return projected;
}

export function projectSessionLogText(
	contents: string,
	options: { fallbackId: string; modifiedAt?: number; sizeBytes?: number },
): ProjectedSessionLog {
	const split = splitDurableLines(contents);
	const { durableLines } = split;
	let { uncommittedTail } = split;
	const issues: SessionParseIssue[] = [];
	const headerLine = durableLines[0];
	let header: JsonlV4Header | undefined;
	if (headerLine === undefined) {
		issues.push({ line: 1, message: "missing durable header" });
	} else {
		const parsedHeader = parseHeader(headerLine);
		if (parsedHeader.ok) {
			header = parsedHeader.value;
		} else {
			issues.push({ line: 1, message: parsedHeader.error.message, raw: headerLine });
		}
	}

	const events: ProjectedEvent[] = [];
	const chat: ChatProjectionItem[] = [];
	const mutationLines = durableLines.slice(1);
	for (const [index, rawLine] of mutationLines.entries()) {
		const line = index + 2;
		if (!rawLine.trim()) continue;
		const parsed = parseMutation(rawLine);
		if (!parsed.ok) {
			if (index === mutationLines.length - 1 && parsed.error.kind === "syntax") {
				uncommittedTail = rawLine;
				break;
			}
			issues.push({ line, message: parsed.error.message, raw: rawLine });
			break;
		}
		const event = projectMutation(parsed.value, line);
		events.push(event);
		const chatItem = projectChatItem(parsed.value);
		if (chatItem !== undefined) chat.push(chatItem);
	}
	annotateEventSurfaces(events);

	const corruptionState =
		issues.length > 0 ? "malformed" : uncommittedTail === undefined ? "clean" : "uncommitted-tail";
	const summary: SessionSummary = {
		id: header?.id ?? options.fallbackId,
		cwd: header?.cwd,
		createdAt: header?.createdAt,
		modifiedAt: options.modifiedAt ?? 0,
		sizeBytes: options.sizeBytes ?? contents.length,
		corruptionState,
		...(issues[0] === undefined ? {} : { error: issues[0].message }),
		...(uncommittedTail === undefined ? {} : { uncommittedTailBytes: Buffer.byteLength(uncommittedTail) }),
	};

	return {
		summary,
		header,
		events,
		chat,
		issues,
		...(uncommittedTail === undefined ? {} : { uncommittedTail }),
	};
}

function projectMutation(mutation: SessionMutation, line: number): ProjectedEvent {
	switch (mutation.kind) {
		case "entry":
			return projectEntry(mutation.entry, mutation.lane, line);
		case "record":
			return projectRecord(mutation.record, line);
		case "lane": {
			const payload = jsonPayload(mutation);
			return {
				seq: mutation.seq,
				line,
				kind: "lane",
				category: "storage",
				label: `lane ${mutation.lane}`,
				summary: `Lane ${mutation.lane} leaf → ${mutation.leafId ?? "null"}`,
				lane: mutation.lane,
				searchText: searchable(["lane", mutation.lane, mutation.leafId]),
				payload,
			};
		}
		case "fact": {
			const label = mutation.fact === "name" ? "session name" : "entry label";
			const summary =
				mutation.fact === "name"
					? `Session name ${mutation.name === undefined ? "cleared" : `set to ${mutation.name}`}`
					: `Label for ${mutation.targetId} ${mutation.label === undefined ? "cleared" : `set to ${mutation.label}`}`;
			return {
				seq: mutation.seq,
				line,
				kind: "fact",
				category: "storage",
				label,
				summary,
				searchText: searchable([label, summary]),
				payload: jsonPayload(mutation),
			};
		}
	}
}

function projectEntry(entry: Entry, lane: string | undefined, line: number): ProjectedEvent {
	if (entry.type === "message") {
		const role = roleOf(entry.message);
		const toolCallId = role === "toolResult" ? stringField(entry.message, "toolCallId") : undefined;
		const category = role === "assistant" ? "assistant" : role === "toolResult" ? "tool" : "user";
		const summary = summarizeMessage(entry.message);
		return {
			seq: entry.seq,
			line,
			kind: "entry",
			category,
			label: `${role} message`,
			summary,
			timestamp: entry.timestamp,
			id: entry.id,
			lane,
			role,
			parentId: entry.parentId,
			toolCallId,
			correlationId: toolCallId,
			searchText: searchable([role, summary, entry.id, toolCallId]),
			payload: jsonPayload(entry),
		};
	}
	if (entry.type === "custom") {
		const customType = entry.customType;
		const category = customType === "request-header" ? "request" : customType.startsWith("constraint/") ? "constraint" : customType.startsWith("extension/") ? "extension" : "record";
		return {
			seq: entry.seq,
			line,
			kind: "entry",
			category,
			label: customType,
			summary: summarizeCustomEntry(entry),
			timestamp: entry.timestamp,
			id: entry.id,
			lane,
			parentId: entry.parentId,
			searchText: searchable([customType, summarizeCustomEntry(entry), entry.id]),
			payload: jsonPayload(entry),
		};
	}
	const category = entry.type === "compaction" || entry.type === "branch_summary" ? "compaction" : "record";
	return {
		seq: entry.seq,
		line,
		kind: "entry",
		category,
		label: entry.type,
		summary: summarizeEntry(entry),
		timestamp: entry.timestamp,
		id: entry.id,
		lane,
		parentId: entry.parentId,
		searchText: searchable([entry.type, summarizeEntry(entry), entry.id]),
		payload: jsonPayload(entry),
	};
}

function projectRecord(record: LaneRecord, line: number): ProjectedEvent {
	const category = recordCategory(record);
	const summary = summarizeRecord(record);
	const runId = stringField(record, "runId") ?? (record.type === "operation_started" ? record.id : undefined);
	const toolCallId = stringField(record, "toolCallId");
	return {
		seq: record.seq,
		line,
		kind: "record",
		category,
		label: record.type,
		summary,
		timestamp: record.timestamp,
		id: record.id,
		lane: record.lane,
		runId,
		toolCallId,
		correlationId: toolCallId ?? runId,
		searchText: searchable([record.type, summary, record.id, runId, toolCallId]),
		payload: jsonPayload(record),
	};
}

function projectChatItem(mutation: SessionMutation): ChatProjectionItem | undefined {
	if (mutation.kind !== "entry" || mutation.entry.type !== "message") return undefined;
	const entry = mutation.entry;
	const role = roleOf(entry.message);
	if (role !== "user" && role !== "assistant" && role !== "toolResult") return undefined;
	const toolCallIds = role === "assistant" ? toolCallIdsOf(entry.message) : [];
	const toolCallId = role === "toolResult" ? stringField(entry.message, "toolCallId") : undefined;
	return {
		seq: entry.seq,
		entryId: entry.id,
		role,
		summary: summarizeMessage(entry.message),
		timestamp: entry.timestamp,
		toolCallIds,
		...(toolCallId === undefined ? {} : { toolCallId }),
		...(booleanField(entry.message, "isError") === undefined ? {} : { isError: booleanField(entry.message, "isError") }),
		payload: jsonPayload(entry.message),
	};
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

function recordCategory(record: LaneRecord): TrajectoryCategory {
	switch (record.type) {
		case "operation_started":
		case "abort_requested":
		case "step_attempt":
			return record.type === "step_attempt" && record.step === "compaction" ? "compaction" : "operation";
		case "operation_finished":
			return record.error?.code === "INTERRUPTED" ? "repair" : "operation";
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
	switch (entry.type) {
		case "compaction":
			return `Compaction summary (${entry.tokensBefore} tokens before): ${clip(entry.summary)}`;
		case "branch_summary":
			return `Branch summary from ${entry.fromId}: ${clip(entry.summary)}`;
		case "model_change":
			return `Model changed to ${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return `Thinking level changed to ${entry.thinkingLevel}`;
		case "active_tools_change":
			return `Active tools: ${entry.activeToolNames.join(", ") || "none"}`;
		case "message":
			return summarizeMessage(entry.message);
		case "custom":
			return summarizeCustomEntry(entry);
	}
}

function summarizeCustomEntry(entry: Extract<Entry, { type: "custom" }>): string {
	if (entry.customType === "constraint/add") {
		return `Constraint added: ${clip(stringField(entry.data, "text") ?? JSON.stringify(entry.data))}`;
	}
	if (entry.customType === "constraint/revoke") {
		return `Constraint revoked: ${stringField(entry.data, "id") ?? clip(JSON.stringify(entry.data))}`;
	}
	if (entry.customType === "request-header") {
		const model = objectField(entry.data, "model");
		const provider = stringField(model, "provider");
		const modelId = stringField(model, "id");
		const toolCount = Array.isArray((entry.data as { tools?: unknown } | undefined)?.tools)
			? (entry.data as { tools: unknown[] }).tools.length
			: undefined;
		return `Provider request ${provider ?? "unknown"}${modelId ? `/${modelId}` : ""}${
			toolCount === undefined ? "" : ` with ${toolCount} tools`
		}`;
	}
	if (entry.customType.startsWith("extension/")) {
		return summarizeExtensionEntry(entry.customType, entry.data);
	}
	return `${entry.customType}: ${clip(JSON.stringify(entry.data ?? null))}`;
}

function summarizeExtensionEntry(customType: string, data: unknown): string {
	const extensionId = stringField(data, "extensionId") ?? "unknown";
	const revisionId = stringField(data, "revisionId");
	const action = stringField(data, "requestedAction");
	switch (customType) {
		case "extension/intent-scheduled":
			return `Extension ${extensionId} scheduled ${action ?? "intent"}${revisionId ? ` for revision ${revisionId}` : ""}`;
		case "extension/defined":
			return `Extension ${extensionId} defined${revisionId ? ` revision ${revisionId}` : ""}`;
		case "extension/approved":
			return `Extension ${extensionId} approved${revisionId ? ` revision ${revisionId}` : ""}`;
		case "extension/started":
			return `Extension ${extensionId} started${revisionId ? ` revision ${revisionId}` : ""}`;
		case "extension/stopped":
			return `Extension ${extensionId} stopped${revisionId ? ` revision ${revisionId}` : ""}`;
		case "extension/updated":
			return `Extension ${extensionId} updated${revisionId ? ` revision ${revisionId}` : ""}`;
		case "extension/rolled-back":
			return `Extension ${extensionId} rolled back${revisionId ? ` to revision ${revisionId}` : ""}`;
		case "extension/removed":
			return `Extension ${extensionId} removed`;
		case "extension/failed":
			return `Extension ${extensionId} failed: ${stringField(data, "code") ?? stringField(data, "errorCode") ?? "unknown"}`;
		default:
			return `${customType}: ${clip(JSON.stringify(data ?? null))}`;
	}
}

function summarizeRecord(record: LaneRecord): string {
	switch (record.type) {
		case "operation_started":
			return `Started ${record.intent.kind} operation ${record.id}`;
		case "operation_finished":
			return `Finished operation ${record.runId}: ${record.outcome}${record.error ? ` (${record.error.message})` : ""}`;
		case "abort_requested":
			return `Abort requested for ${record.runId}`;
		case "step_attempt":
			return `${record.step} attempt ${record.attempt} → ${record.resultEntryId}`;
		case "tool_started":
			return `Tool ${record.toolName} call ${record.toolCallId} → ${record.resultEntryId}`;
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
	if (Array.isArray(content)) {
		const parts = content.map((part) => summarizeContentPart(part)).filter(Boolean);
		if (parts.length > 0) return clip(parts.join(" "));
	}
	if (typeof content === "string") return clip(content);
	if (role === "assistant") {
		const calls = toolCallIdsOf(message);
		if (calls.length > 0) return `Assistant requested ${calls.length} tool call${calls.length === 1 ? "" : "s"}`;
	}
	return `${role} message`;
}

function summarizeContentPart(part: unknown): string {
	if (typeof part === "string") return part;
	if (part === null || typeof part !== "object") return "";
	const record = part as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (record.type === "toolCall") return `tool:${String(record.name ?? "unknown")}#${String(record.id ?? "?")}`;
	if (record.type === "image") return "[image]";
	return "";
}

function toolCallIdsOf(message: unknown): string[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type: string; id?: unknown } => {
			return part !== null && typeof part === "object" && (part as { type?: unknown }).type === "toolCall";
		})
		.map((part) => (typeof part.id === "string" ? part.id : undefined))
		.filter((id): id is string => id !== undefined);
}

function roleOf(value: unknown): string {
	return typeof value === "object" && value !== null && typeof (value as { role?: unknown }).role === "string"
		? (value as { role: string }).role
		: "unknown";
}

function stringField(value: unknown, field: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const fieldValue = (value as Record<string, unknown>)[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

function objectField(value: unknown, field: string): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const fieldValue = (value as Record<string, unknown>)[field];
	return fieldValue !== null && typeof fieldValue === "object" && !Array.isArray(fieldValue)
		? (fieldValue as Record<string, unknown>)
		: undefined;
}

function booleanField(value: unknown, field: string): boolean | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const fieldValue = (value as Record<string, unknown>)[field];
	return typeof fieldValue === "boolean" ? fieldValue : undefined;
}

function searchable(parts: readonly unknown[]): string {
	return parts
		.filter((part) => part !== undefined && part !== null)
		.map((part) => String(part).toLowerCase())
		.join(" ");
}

function annotateEventSurfaces(events: ProjectedEvent[]): void {
	const byId = new Map(events.flatMap((event) => (event.id === undefined ? [] : [[event.id, event] as const])));
	const bySeq = new Map(events.map((event) => [event.seq, event]));
	const latestMainLeaf = events.findLast((event) => event.kind === "lane" && event.lane === "main")?.payload;
	const laneLeafId = objectStringField(latestMainLeaf, "leafId") ?? events.findLast((event) => event.kind === "entry")?.id;
	const currentIds = new Set<string>();
	let cursor = laneLeafId;
	while (cursor !== undefined && !currentIds.has(cursor)) {
		currentIds.add(cursor);
		cursor = byId.get(cursor)?.parentId ?? undefined;
	}
	const shadowedIds = new Set<string>();
	const derivedBySeq = new Map<number, number[]>();
	for (const event of events) {
		if (event.category !== "compaction") continue;
		const shadowedEntryIds = stringArrayField(objectField(event.payload, "details"), "shadowedEntryIds");
		const sourceEntryIds = stringArrayField(objectField(event.payload, "details"), "sourceEntryIds");
		const replacesSeqs = seqsForIds(byId, shadowedEntryIds);
		const sourceSeqs = seqsForIds(byId, sourceEntryIds);
		if (replacesSeqs.length > 0) event.replacesSeqs = replacesSeqs;
		if (sourceSeqs.length > 0) event.sourceSeqs = sourceSeqs;
		for (const id of shadowedEntryIds) shadowedIds.add(id);
		for (const seq of [...new Set([...replacesSeqs, ...sourceSeqs])]) {
			derivedBySeq.set(seq, [...(derivedBySeq.get(seq) ?? []), event.seq]);
		}
	}
	for (const event of events) {
		const derivedSeqs = derivedBySeq.get(event.seq);
		if (derivedSeqs !== undefined) event.derivedSeqs = derivedSeqs.toSorted((left, right) => left - right);
		if (event.kind !== "entry" || event.id === undefined) {
			event.surface = "log-only";
		} else if (shadowedIds.has(event.id)) {
			event.surface = "shadowed";
		} else if (currentIds.has(event.id) || bySeq.has(event.seq)) {
			event.surface = currentIds.has(event.id) ? "current" : "log-only";
		} else {
			event.surface = "log-only";
		}
	}
}

function seqsForIds(byId: ReadonlyMap<string, ProjectedEvent>, ids: readonly string[]): number[] {
	return ids
		.map((id) => byId.get(id)?.seq)
		.filter((seq): seq is number => seq !== undefined)
		.toSorted((left, right) => left - right);
}

function stringArrayField(value: unknown, field: string): string[] {
	if (value === null || typeof value !== "object") return [];
	const fieldValue = (value as Record<string, unknown>)[field];
	return Array.isArray(fieldValue) ? fieldValue.filter((item): item is string => typeof item === "string") : [];
}

function objectStringField(value: unknown, field: string): string | undefined {
	return stringField(value, field);
}

function clip(value: string | undefined, maxLength = 180): string {
	if (value === undefined) return "";
	const collapsed = value.replaceAll(/\s+/g, " ").trim();
	return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

function jsonPayload(value: unknown): JsonValue {
	return structuredClone(value) as JsonValue;
}
