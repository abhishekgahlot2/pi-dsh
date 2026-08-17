import type { Static, TSchema } from "typebox";

// Composition-time tool binding preserves the durable pre-dispatch checkpoint boundary.
import type { AgentHarnessTool } from "../vendor/pi/harness/types.ts";
import type { ExecutionToolContext } from "../vendor/pi/harness/tools/tool-context.ts";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "../vendor/pi/harness/tools/index.ts";
import type { AgentTool } from "../vendor/pi/types.ts";

/** Bind Pi harness-tool context once at composition time; the loop still receives ordinary Pi tools. */
export function bindToolContext<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
): AgentTool<TParameters, TDetails> {
	const { execute, ...definition } = tool;
	return {
		...definition,
		execute(
			toolCallId: string,
			params: Static<TParameters>,
			signal,
			onUpdate,
		) {
			return execute(toolCallId, params, signal, onUpdate, context);
		},
	};
}

export function createDefaultTools(context: ExecutionToolContext): AgentTool[] {
	return [
		bindToolContext(createReadTool(), context),
		bindToolContext(createBashTool(), context),
		bindToolContext(createEditTool(), context),
		bindToolContext(createWriteTool(), context),
	];
}
