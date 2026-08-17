import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelCompactionSummarizer } from "../src/summarizer.ts";
import type { StreamFn } from "../vendor/pi/types.ts";

const model = {
	provider: "openai",
	id: "summary-model",
	name: "Summary Model",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
} satisfies Model<"openai-completions">;

const usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function summaryMessage(stopReason: "stop" | "error", text: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text }],
		usage,
		stopReason,
		...(stopReason === "error" ? { errorMessage: "summary failed" } : {}),
		timestamp: 1,
	};
}

function streamMessage(message: AssistantMessage): StreamFn {
	return () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
			else stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

describe("ModelCompactionSummarizer", () => {
	it("returns trimmed summary text and provider usage", async () => {
		const summarizer = new ModelCompactionSummarizer(model, streamMessage(summaryMessage("stop", "  compact  ")));
		await expect(
			summarizer.summarize({ shadowedEntries: [], shadowedMessages: [], retainedTail: [], reason: "manual" }),
		).resolves.toEqual({ summary: "compact", usage });
	});

	it("rejects provider failures instead of recording them as summaries", async () => {
		const summarizer = new ModelCompactionSummarizer(model, streamMessage(summaryMessage("error", "")));
		await expect(
			summarizer.summarize({ shadowedEntries: [], shadowedMessages: [], retainedTail: [], reason: "manual" }),
		).rejects.toThrow("summary failed");
	});
});
