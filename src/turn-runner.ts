// Turn-boundary threshold and overflow recovery remain bounded by durable progress.

import { isContextOverflow, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AgentLoopConfig, AgentMessage, PrepareNextTurnContext } from "../vendor/pi/types.ts";
import type { SessionStorage } from "../vendor/pi/harness/session/types.ts";
import {
	compactClosedPrefix,
	OverflowRetryGate,
	type CompactionPolicy,
	type CompactionResult,
	type CompactionSummarizer,
} from "./compaction.ts";
import { buildRepairSafeSessionContext } from "./repair.ts";

export class ProviderResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderResponseError";
	}
}

export interface LoopResultContext {
	runId: string;
	messages: AgentMessage[];
	continueRun: () => Promise<AgentMessage[]>;
}

export class TurnCompactionController {
	constructor(
		private readonly store: SessionStorage,
		private readonly model: Model<Api>,
		private readonly summarizer: CompactionSummarizer | undefined,
		private readonly policy: CompactionPolicy,
		private readonly activeRunId: () => string | null,
	) {}

	compactManual(
		options: { reason?: "manual" | "threshold" | "overflow"; explicitCutEntryId?: string } = {},
	): Promise<CompactionResult | undefined> {
		if (this.summarizer === undefined) throw new Error("No compaction summarizer is configured");
		return compactClosedPrefix(this.store, this.summarizer, {
			policy: this.policy,
			reason: options.reason ?? "manual",
			...(options.explicitCutEntryId === undefined ? {} : { explicitCutEntryId: options.explicitCutEntryId }),
		});
	}

	async prepareNextTurn(
		context: PrepareNextTurnContext,
		userPrepareNextTurn: AgentLoopConfig["prepareNextTurn"],
	) {
		const userUpdate = await userPrepareNextTurn?.(context);
		const runId = this.activeRunId();
		if (this.summarizer === undefined || runId === null) return userUpdate;
		const compaction = await compactClosedPrefix(this.store, this.summarizer, {
			policy: this.policy,
			reason: "threshold",
			runId,
		});
		if (compaction === undefined) return userUpdate;
		return {
			...userUpdate,
			context: {
				...(userUpdate?.context ?? context.context),
				messages: await this.durableMessages(),
			},
		};
	}

	async recoverLoopResult(context: LoopResultContext): Promise<AgentMessage[]> {
		const allMessages = [...context.messages];
		let attemptMessages = context.messages;
		let previousCompactionEntryId: string | undefined;
		const retryGate = new OverflowRetryGate(this.policy.maxOverflowRetries ?? 1);
		while (true) {
			const terminal = finalAssistant(attemptMessages);
			if (terminal === undefined || terminal.stopReason !== "error") {
				if (terminal?.stopReason !== "aborted") retryGate.resetAfterAssistantSuccess();
				return allMessages;
			}
			if (!isContextOverflow(terminal, this.model.contextWindow)) {
				throw new ProviderResponseError(terminal.errorMessage ?? "Provider request failed");
			}
			if (this.summarizer === undefined) {
				throw new ProviderResponseError("Provider context overflowed and no compaction summarizer is configured");
			}
			const compaction = await compactClosedPrefix(this.store, this.summarizer, {
				policy: this.policy,
				reason: "overflow",
				runId: context.runId,
			});
			const nextCompactionEntryId = compaction?.compaction.id;
			if (!retryGate.canRetry(previousCompactionEntryId, nextCompactionEntryId)) {
				throw new ProviderResponseError("Provider context overflow recovery made no durable progress");
			}
			previousCompactionEntryId = nextCompactionEntryId;
			attemptMessages = await context.continueRun();
			allMessages.push(...attemptMessages);
		}
	}

	private async durableMessages(): Promise<AgentMessage[]> {
		const leafId = (await this.store.getLanes()).find((lane) => lane.lane === "main")?.leafId ?? null;
		if (leafId === null) return [];
		const entries = await this.store.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		return buildRepairSafeSessionContext(entries).messages;
	}
}

function finalAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	const message = messages.findLast((candidate) => candidate.role === "assistant");
	return message?.role === "assistant" ? message : undefined;
}
