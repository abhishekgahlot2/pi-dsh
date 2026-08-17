import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "../vendor/pi/types.ts";
import type { CompactionSummarizer } from "./compaction.ts";

// Standalone summaries compact closed history without mutating Pi's loop.

function serializeMessages(messages: readonly AgentMessage[]): string {
	return messages.map((message) => JSON.stringify(message)).join("\n");
}

export class ModelCompactionSummarizer implements CompactionSummarizer {
	constructor(
		private readonly model: Model<Api>,
		private readonly streamFn: StreamFn,
	) {}

	async summarize(input: Parameters<CompactionSummarizer["summarize"]>[0]) {
		const stream = await this.streamFn(
			this.model,
			{
				systemPrompt:
					"Summarize the supplied coding-agent history faithfully and compactly. Preserve decisions, constraints, unfinished work, file paths, commands, errors, and verification evidence. Return only the summary.",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `Compaction reason: ${input.reason}\n\nHistory to summarize:\n${serializeMessages(input.shadowedMessages)}`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ maxRetries: 0, cacheRetention: "none" },
		);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage || `Compaction request ${message.stopReason}`);
		}
		const summary = contentText(message.content).trim();
		if (!summary) throw new Error("Compaction request returned an empty summary");
		return { summary, usage: message.usage };
	}
}
