// Credential-free request capture includes the effective durable constraint section.

import type { Api, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../vendor/pi/types.ts";
import { constraintSectionMessage, type Constraint, renderConstraintSection } from "./constraints.ts";

export const REQUEST_HEADER_TYPE = "request-header";

export interface PromptContribution {
	id: string;
	text: string;
}

export function effectiveRequestSnapshot(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	constraints: readonly Constraint[],
	promptContributors: readonly PromptContribution[] = [],
): { context: Context; data: Record<string, unknown> } {
	const constraintSection = renderConstraintSection(constraints);
	const promptContributionSection = renderPromptContributionSection(promptContributors);
	const messages = [
		...constraintSectionMessage(constraints),
		...promptContributionSectionMessage(promptContributors),
	].filter(isProviderMessage);
	const effectiveContext = { ...context, messages: [...messages, ...context.messages] } satisfies Context;
	return {
		context: effectiveContext,
		data: stripUndefinedJson({
			model: { provider: model.provider, id: model.id, api: model.api },
			systemPrompt: effectiveContext.systemPrompt,
			tools: effectiveContext.tools?.map(toolSchemaSnapshot),
			promptContributors: promptContributors.map(promptContributionSnapshot),
			options: samplingOptionsSnapshot(options),
			constraintSection,
			promptContributionSection,
		}) as Record<string, unknown>,
	};
}

export function stripUndefinedJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.filter((entry) => entry !== undefined).map(stripUndefinedJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entryValue]) => entryValue !== undefined)
				.map(([key, entryValue]) => [key, stripUndefinedJson(entryValue)]),
		);
	}
	return value;
}

function isProviderMessage(message: AgentMessage): message is Context["messages"][number] {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function toolSchemaSnapshot(tool: Tool): Record<string, unknown> {
	return stripUndefinedJson({ name: tool.name, description: tool.description, parameters: tool.parameters }) as Record<
		string,
		unknown
	>;
}

function renderPromptContributionSection(promptContributors: readonly PromptContribution[]): string {
	if (promptContributors.length === 0) return "";
	const lines = [
		"<session-prompt-contributors>",
		"These active runtime prompt contributions apply to this request:",
		...promptContributors.map((contributor) => `- ${contributor.id}: ${contributor.text}`),
		"</session-prompt-contributors>",
	];
	return lines.join("\n");
}

function promptContributionSectionMessage(promptContributors: readonly PromptContribution[], timestamp = 0): AgentMessage[] {
	const rendered = renderPromptContributionSection(promptContributors);
	if (!rendered) return [];
	return [{ role: "user", content: [{ type: "text", text: rendered }], timestamp }];
}

function promptContributionSnapshot(contributor: PromptContribution): Record<string, unknown> {
	return stripUndefinedJson({ id: contributor.id, text: contributor.text }) as Record<string, unknown>;
}

function samplingOptionsSnapshot(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	return stripUndefinedJson({
		temperature: options?.temperature,
		maxTokens: options?.maxTokens,
		samplingParams: options?.samplingParams,
		cacheRetention: options?.cacheRetention,
		timeoutMs: options?.timeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
	}) as Record<string, unknown>;
}
