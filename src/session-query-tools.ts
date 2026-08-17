import { Type, type Static } from "typebox";
import type { JsonValue } from "../vendor/pi/harness/session/types.ts";
import type { AgentTool, AgentToolResult } from "../vendor/pi/types.ts";
import {
	getSessionEventWindow,
	getSessionLineage,
	searchSessionEvents,
	traceSessionEvent,
} from "./session-query.ts";

export interface SessionQueryToolsOptions {
	readonly sessionsRoot: string;
}

const searchParameters = Type.Object({
	text: Type.String({ minLength: 1 }),
	sessionId: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	runId: Type.Optional(Type.String()),
	toolCallId: Type.Optional(Type.String()),
	extensionId: Type.Optional(Type.String()),
	eventSurface: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("shadowed"), Type.Literal("log-only")])),
	corruptionState: Type.Optional(Type.Union([Type.Literal("clean"), Type.Literal("malformed"), Type.Literal("uncommitted-tail")])),
	limit: Type.Optional(Type.Number()),
	cursor: Type.Optional(Type.String()),
});

const windowParameters = Type.Object({
	sessionId: Type.String(),
	seq: Type.Number(),
	before: Type.Optional(Type.Number()),
	after: Type.Optional(Type.Number()),
});

const traceParameters = Type.Object({ sessionId: Type.String(), seq: Type.Number() });
const lineageParameters = Type.Object({ sessionId: Type.String() });

export function createSessionQueryTools(options: SessionQueryToolsOptions): AgentTool[] {
	return [
		{
			name: "session_search",
			label: "Search session history",
			description: "Search Pi v4 session logs with bounded scan limits and stable citations.",
			parameters: searchParameters,
			async execute(_toolCallId, params) {
				const input = params as Static<typeof searchParameters>;
				return toolResult(await searchSessionEvents(options.sessionsRoot, {
					text: input.text,
					limit: input.limit,
					cursor: input.cursor,
					filters: {
						sessionId: input.sessionId,
						cwd: input.cwd,
						category: input.category,
						role: input.role,
						runId: input.runId,
						toolCallId: input.toolCallId,
						extensionId: input.extensionId,
						eventSurface: input.eventSurface,
						corruptionState: input.corruptionState,
					},
				}));
			},
		},
		{
			name: "session_event_window",
			label: "Read session event window",
			description: "Read a bounded before/after window around one event sequence.",
			parameters: windowParameters,
			async execute(_toolCallId, params) {
				const input = params as Static<typeof windowParameters>;
				return toolResult(await getSessionEventWindow(options.sessionsRoot, input.sessionId, input.seq, {
					before: input.before,
					after: input.after,
				}));
			},
		},
		{
			name: "session_trace",
			label: "Trace session event",
			description: "Trace direct causal relationships for one session event.",
			parameters: traceParameters,
			async execute(_toolCallId, params) {
				const input = params as Static<typeof traceParameters>;
				return toolResult(await traceSessionEvent(options.sessionsRoot, input.sessionId, input.seq));
			},
		},
		{
			name: "session_lineage",
			label: "Read session lineage",
			description: "Read parent and descendant relationships from discovered session headers.",
			parameters: lineageParameters,
			async execute(_toolCallId, params) {
				const input = params as Static<typeof lineageParameters>;
				return toolResult(await getSessionLineage(options.sessionsRoot, input.sessionId));
			},
		},
	];
}

function toolResult(details: unknown): AgentToolResult<JsonValue> {
	const value = structuredClone(details) as JsonValue;
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}
