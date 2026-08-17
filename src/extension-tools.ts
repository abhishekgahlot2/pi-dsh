import { Type, type Static, type TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "../vendor/pi/types.ts";
import {
	ExtensionRuntime,
	ExtensionRuntimeError,
	hashExtensionSource,
	validateExtensionDefinitionInput,
	type ExtensionContributionManifest,
	type ExtensionReceipt,
	type ExtensionAction,
	type JsonValue,
	type RegisteredExtensionTool,
} from "./extensions.ts";

const jsonSchema = Type.Unsafe<JsonValue>({});

const lifecycleSchema = Type.Object({
	extensionId: Type.String(),
	revisionId: Type.Optional(Type.String()),
	sourceHash: Type.Optional(Type.String()),
});

const defineSchema = Type.Object({
	extensionId: Type.String(),
	purpose: Type.String(),
	source: Type.String(),
	manifest: Type.Unsafe<ExtensionContributionManifest>({}),
	metadata: Type.Optional(jsonSchema),
});

export interface ExtensionLifecycleToolsOptions {
	readonly getRunId: () => string | null;
}

export const EXTENSION_LIFECYCLE_TOOL_NAMES = [
	"extension_inspect",
	"extension_define",
	"extension_run",
	"extension_stop",
	"extension_update",
	"extension_rollback",
	"extension_remove",
] as const;

export interface ExtensionLifecycleToolDetails {
	readonly receipt?: ExtensionReceipt;
	readonly error?: {
		readonly code: string;
		readonly message: string;
	};
}

export function createExtensionLifecycleTools(runtime: ExtensionRuntime, options: ExtensionLifecycleToolsOptions): AgentTool[] {
	return [
		createInspectTool(runtime),
		createDefineTool(runtime, options),
		createScheduleTool(runtime, options, "extension_run", "run"),
		createScheduleTool(runtime, options, "extension_stop", "stop"),
		createUpdateTool(runtime, options),
		createScheduleTool(runtime, options, "extension_rollback", "rollback"),
		createScheduleTool(runtime, options, "extension_remove", "remove"),
	];
}

export function createPiToolsForExtensionRuntime(runtime: ExtensionRuntime): AgentTool[] {
	return runtime.getContributions().flatMap((contribution) =>
		contribution.tools.map((tool) => createContributedPiTool(tool)),
	);
}

function createInspectTool(runtime: ExtensionRuntime): AgentTool<TSchema, ExtensionLifecycleToolDetails> {
	return {
		name: "extension_inspect",
		label: "extension_inspect",
		description: "Inspect extension runtime state, pending definitions, active revisions, and trust limits.",
		parameters: Type.Object({}),
		async execute() {
			return jsonToolResult(toJsonValue(runtime.inspect()));
		},
	};
}

function createDefineTool(runtime: ExtensionRuntime, options: ExtensionLifecycleToolsOptions): AgentTool<typeof defineSchema, ExtensionLifecycleToolDetails> {
	return {
		name: "extension_define",
		label: "extension_define",
		description: "Schedule a session-owned extension definition for application after the current durable operation finishes.",
		parameters: defineSchema,
		async execute(toolCallId, params) {
			try {
				const sourceHash = prevalidateDefine(params);
				const receipt = await runtime.scheduleIntent({
					requestedAction: "define",
					extensionId: params.extensionId,
					sourceHash,
					runId: requireRunId(options),
					toolCallId,
					definition: params,
				});
				return jsonToolResult({ status: "scheduled-for-next-turn", intentId: receipt.intentId }, { receipt: {
					type: "extension/intent-scheduled",
					sessionId: runtime.sessionId,
					extensionId: params.extensionId,
					sourceHash,
					status: "scheduled-for-next-turn",
					code: "EXTENSION_INTENT_SCHEDULED",
					intent: receipt,
				} });
			} catch (error) {
				return extensionErrorResult(error);
			}
		},
	};
}

function createUpdateTool(runtime: ExtensionRuntime, options: ExtensionLifecycleToolsOptions): AgentTool<typeof defineSchema, ExtensionLifecycleToolDetails> {
	return {
		name: "extension_update",
		label: "extension_update",
		description: "Schedule an immutable extension revision update for application after the current durable operation finishes.",
		parameters: defineSchema,
		async execute(toolCallId, params) {
			try {
				const sourceHash = prevalidateDefine(params);
				const receipt = await runtime.scheduleIntent({
					requestedAction: "update",
					extensionId: params.extensionId,
					sourceHash,
					runId: requireRunId(options),
					toolCallId,
					definition: params,
				});
				return jsonToolResult({ status: "scheduled-for-next-turn", intentId: receipt.intentId });
			} catch (error) {
				return extensionErrorResult(error);
			}
		},
	};
}

function createScheduleTool(
	runtime: ExtensionRuntime,
	options: ExtensionLifecycleToolsOptions,
	name: string,
	action: Exclude<ExtensionAction, "define" | "update">,
): AgentTool<typeof lifecycleSchema, ExtensionLifecycleToolDetails> {
	return {
		name,
		label: name,
		description: `Schedule extension ${action} for application after the current durable operation finishes.`,
		parameters: lifecycleSchema,
		async execute(toolCallId, params) {
			try {
				const receipt = await runtime.scheduleIntent({
					requestedAction: action,
					extensionId: params.extensionId,
					revisionId: params.revisionId,
					sourceHash: params.sourceHash,
					runId: requireRunId(options),
					toolCallId,
				});
				return jsonToolResult({ status: "scheduled-for-next-turn", intentId: receipt.intentId });
			} catch (error) {
				return extensionErrorResult(error);
			}
		},
	};
}

function prevalidateDefine(params: Static<typeof defineSchema>): string {
	validateExtensionDefinitionInput(params);
	return hashExtensionSource(params.source);
}

function requireRunId(options: ExtensionLifecycleToolsOptions): string {
	const runId = options.getRunId();
	if (runId === null) throw new ExtensionRuntimeError("EXTENSION_INTENT_SCHEDULED", "Extension lifecycle tool requires an active run");
	return runId;
}

function createContributedPiTool(tool: RegisteredExtensionTool): AgentTool<TSchema, JsonValue> {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: Type.Unsafe<JsonValue>(schemaOptions(tool.inputSchema)),
		async execute(toolCallId, params, signal) {
			const result = await tool.execute(params as JsonValue, { signal, toolCallId });
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	};
}

function schemaOptions(schema: JsonValue): Record<string, unknown> {
	return typeof schema === "object" && schema !== null && !Array.isArray(schema)
		? structuredClone(schema) as Record<string, unknown>
		: {};
}

function toJsonValue(value: unknown): JsonValue {
	return structuredClone(value) as JsonValue;
}

function jsonToolResult(details: JsonValue, extra?: ExtensionLifecycleToolDetails): AgentToolResult<ExtensionLifecycleToolDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details: extra ?? {},
	};
}

function extensionErrorResult(error: unknown): AgentToolResult<ExtensionLifecycleToolDetails> {
	const normalized =
		error instanceof ExtensionRuntimeError
			? error
			: new ExtensionRuntimeError("EXTENSION_SOURCE_EVALUATION_FAILED", error instanceof Error ? error.message : String(error));
	return {
		content: [{ type: "text", text: `${normalized.code}: ${normalized.message}` }],
		details: { error: { code: normalized.code, message: normalized.message } },
	};
}
