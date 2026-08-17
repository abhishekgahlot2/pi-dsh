import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../vendor/pi/types.ts";
import type {
	CompactionEntry,
	Entry,
	LaneRecord,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	SessionStorage,
} from "../vendor/pi/harness/session/types.ts";
import {
	CompactionRejectedError,
	OverflowRetryGate,
	SurfaceChangedError,
	compactClosedPrefix,
	selectClosedPrefix,
	shouldCompactAtStep,
} from "../src/compaction.ts";

class MemoryStore implements SessionStorage {
	private seq = 0;
	private leafId: string | null = null;
	readonly entries: Entry[] = [];
	readonly records: LaneRecord[] = [];

	async getMetadata(): Promise<{ id: string; createdAt: number }> {
		return { id: "test", createdAt: 0 };
	}
	async getLanes(): Promise<{ lane: string; leafId: string | null }[]> {
		return [{ lane: "main", leafId: this.leafId }];
	}
	async createLane(): Promise<void> {}
	async moveLane(_lane: string, to: string | null): Promise<void> {
		this.leafId = to;
	}
	async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		if (lane !== "main") throw new Error("unexpected lane");
		const full = { ...entry, seq: ++this.seq, parentId: this.leafId, timestamp: this.seq } as unknown as TEntry;
		this.entries.push(full);
		this.leafId = full.id;
		return full;
	}
	async appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		const full = { ...record, seq: ++this.seq, timestamp: this.seq } as unknown as TRecord;
		this.records.push(full);
		return full;
	}
	async getEntry(id: string): Promise<Entry | undefined> {
		return this.entries.find((entry) => entry.id === id);
	}
	async findEntries(): Promise<Entry[]> {
		return [...this.entries].reverse();
	}
	async findEntriesOnBranch(query: { start: string; order?: "oldestFirst" | "newestFirst" }): Promise<Entry[]> {
		const path: Entry[] = [];
		let cursor: string | null = query.start;
		while (cursor !== null) {
			const entry = this.entries.find((candidate) => candidate.id === cursor);
			if (!entry) throw new Error(`missing ${cursor}`);
			path.push(entry);
			cursor = entry.parentId;
		}
		return query.order === "oldestFirst" ? path.reverse() : path;
	}
	async findRecords(query?: { type?: LaneRecord["type"]; runId?: string; operationKind?: string; order?: "oldestFirst" | "newestFirst"; limit?: number }): Promise<LaneRecord[]> {
		let records = this.records.filter((record) => {
			if (query?.type !== undefined && record.type !== query.type) return false;
			if (query?.runId !== undefined) {
				if (record.type === "operation_started") return record.id === query.runId;
				if (!("runId" in record) || record.runId !== query.runId) return false;
			}
			if (
				query?.operationKind !== undefined &&
				(record.type !== "operation_started" || record.intent.kind !== query.operationKind)
			) {
				return false;
			}
			return true;
		});
		if (query?.order !== "oldestFirst") records = records.toReversed();
		return query?.limit === undefined ? records : records.slice(0, query.limit);
	}
	async findOpenOperations(): Promise<OperationStartedRecord[]> {
		const starts = this.records.filter((record): record is OperationStartedRecord => record.type === "operation_started");
		const closed = new Set(
			this.records.flatMap((record) => (record.type === "operation_finished" ? [record.runId] : [])),
		);
		return starts.filter((record) => !closed.has(record.id)).toReversed();
	}
	async getLog(): Promise<[]> {
		return [];
	}
	async getName(): Promise<undefined> {
		return undefined;
	}
	async setName(): Promise<void> {}
	async getLabel(): Promise<undefined> {
		return undefined;
	}
	async setLabel(): Promise<void> {}
	async getStats(): Promise<never> {
		throw new Error("unused");
	}
	async runExclusive<T>(job: () => Promise<T>): Promise<T> {
		return job();
	}
}

function user(id: string, content: string): ProvisionedEntry<Entry> {
	return { type: "message", id, message: { role: "user", content: [{ type: "text", text: content }], timestamp: 0 } };
}

function assistantTool(id: string): ProvisionedEntry<Entry> {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			api: "test",
			provider: "test",
			model: "test",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
			stopReason: "toolUse",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: 0,
		},
	};
}

function toolResult(id: string): ProvisionedEntry<Entry> {
	return {
		type: "message",
		id,
		message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 } as AgentMessage,
	};
}

describe("compaction", () => {
	it("uses threshold ratio to decide step-boundary compaction", () => {
		expect(shouldCompactAtStep(79, { contextWindow: 100, retainedTailTokens: 0 })).toBe(false);
		expect(shouldCompactAtStep(80, { contextWindow: 100, retainedTailTokens: 0 })).toBe(true);
	});

	it("walks automatic cuts back to preserve tool-pair integrity", async () => {
		const store = new MemoryStore();
		await store.appendEntry(user("u1", "old ".repeat(100)), "main");
		await store.appendEntry(assistantTool("a1"), "main");
		await store.appendEntry(toolResult("t1"), "main");
		await store.appendEntry(user("u2", "new"), "main");

		const selected = selectClosedPrefix(store.entries, 1);

		expect(selected.shadowedEntries.map((entry) => entry.id)).toEqual(["u1", "a1", "t1"]);
		expect(() => selectClosedPrefix(store.entries, 1, "t1")).toThrow(CompactionRejectedError);
	});

	it("commits a closed-prefix compaction with provenance and retained tail", async () => {
		const store = new MemoryStore();
		await store.appendEntry(user("u1", "old ".repeat(100)), "main");
		await store.appendEntry(user("u2", "middle ".repeat(80)), "main");
		await store.appendEntry(user("u3", "tail"), "main");

		const result = await compactClosedPrefix(
			store,
			{ summarize: async () => ({ summary: "short" }) },
			{ policy: { contextWindow: 10, thresholdRatio: 0.1, retainedTailTokens: 1 }, reason: "threshold" },
		);

		const compaction = result?.compaction as CompactionEntry;
		expect(compaction.type).toBe("compaction");
		expect(compaction.retainedTail).toEqual([{ role: "user", content: [{ type: "text", text: "tail" }], timestamp: 0 }]);
		expect((compaction.details as { shadowedEntryIds: string[] }).shadowedEntryIds).toEqual(["u1", "u2"]);
		expect(store.records.map((record) => record.type)).toEqual([
			"operation_started",
			"step_attempt",
			"operation_finished",
		]);
	});

	it("uses a step bracket inside an open run without opening or closing another operation", async () => {
		const store = new MemoryStore();
		await store.appendEntry(user("u1", "old ".repeat(100)), "main");
		await store.appendEntry(user("u2", "middle ".repeat(80)), "main");
		await store.appendEntry(user("u3", "tail"), "main");
		await store.appendRecord<OperationStartedRecord>({
			type: "operation_started",
			id: "run-1",
			lane: "main",
			sourceLeafId: "u3",
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		});

		await compactClosedPrefix(
			store,
			{ summarize: async () => ({ summary: "short" }) },
			{
				policy: { contextWindow: 10, thresholdRatio: 0.1, retainedTailTokens: 1 },
				reason: "threshold",
				runId: "run-1",
			},
		);

		expect(store.records.map((record) => record.type)).toEqual(["operation_started", "step_attempt"]);
		expect((await store.findOpenOperations())[0]?.id).toBe("run-1");
	});

	it("rejects non-shrinking summaries and closes the bracket failed", async () => {
		const store = new MemoryStore();
		await store.appendEntry(user("u1", "x"), "main");
		await store.appendEntry(user("u2", "y"), "main");

		await expect(
			compactClosedPrefix(
				store,
				{ summarize: async () => ({ summary: "not shrinking ".repeat(100) }) },
				{ policy: { contextWindow: 1, thresholdRatio: 0.1, retainedTailTokens: 1 } },
			),
		).rejects.toThrow(CompactionRejectedError);
		expect(store.entries.filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(store.records.at(-1)).toMatchObject({ type: "operation_finished", outcome: "failed" });
	});

	it("detects append races during summary before commit", async () => {
		const store = new MemoryStore();
		await store.appendEntry(user("u1", "old ".repeat(100)), "main");
		await store.appendEntry(user("u2", "tail"), "main");

		await expect(
			compactClosedPrefix(
				store,
				{
					summarize: async () => {
						await store.appendEntry(user("u3", "raced"), "main");
						return { summary: "short" };
					},
				},
				{ policy: { contextWindow: 1, thresholdRatio: 0.1, retainedTailTokens: 1 } },
			),
		).rejects.toThrow(SurfaceChangedError);
		expect(store.records.at(-1)).toMatchObject({ type: "operation_finished", outcome: "failed" });
	});

	it("gates overflow retry on durable compaction progress", () => {
		const gate = new OverflowRetryGate(1);

		expect(gate.canRetry(undefined, undefined)).toBe(false);
		expect(gate.canRetry("old", "new")).toBe(true);
		expect(gate.canRetry("new", "newer")).toBe(false);
		gate.resetAfterAssistantSuccess();
		expect(gate.canRetry("new", "newer")).toBe(true);
	});
});
