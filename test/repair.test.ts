import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { InMemorySessionRepo } from "../vendor/pi/harness/session/memory.ts";
import type {
	Entry,
	MessageEntry,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	RecordBase,
} from "../vendor/pi/harness/session/types.ts";
import { SessionError } from "../vendor/pi/harness/session/types.ts";
import {
	buildRepairSafeSessionContext,
	type RepairSessionStore,
	repairInterruptedOperation,
	TOOL_NOT_STARTED_TEXT,
	TOOL_OUTCOME_UNKNOWN_TEXT,
} from "../src/repair.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(id: string, toolCallIds: string[]): Omit<MessageEntry, "parentId" | "seq" | "timestamp"> {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: "test",
			content: toolCallIds.map((toolCallId) => ({
				type: "toolCall",
				id: toolCallId,
				name: `tool-${toolCallId}`,
				arguments: { value: toolCallId },
			})),
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
}

function userEntry(id: string): Omit<MessageEntry, "parentId" | "seq" | "timestamp"> {
	return { type: "message", id, message: { role: "user", content: "hello", timestamp: 1 } };
}

function toolResultEntry(
	id: string,
	toolCallId: string,
): Omit<MessageEntry, "parentId" | "seq" | "timestamp"> {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId,
			toolName: `tool-${toolCallId}`,
			content: [{ type: "text", text: "real result" }],
			details: {},
			isError: false,
			timestamp: 1,
		},
	};
}

function runStart(id: string, sourceLeafId: string | null): Omit<OperationStartedRecord, "seq" | "timestamp"> {
	return {
		type: "operation_started",
		id,
		lane: "main",
		sourceLeafId,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

async function createSession() {
	const repo = new InMemorySessionRepo();
	return repo.create({ id: "session" });
}

describe("repairInterruptedOperation", () => {
	it("is a no-op on a balanced log", async () => {
		const session = await createSession();
		await session.appendEntry(userEntry("u1"), "main");
		const before = await session.getLog();
		const result = await repairInterruptedOperation(session);
		deepStrictEqual(result, { runId: null, appendedEntries: 0, appendedRecords: 0 });
		deepStrictEqual(await session.getLog(), before);
	});

	it("synthesizes a retry-safe result when the tool was never started", async () => {
		const session = await createSession();
		await session.appendRecord(runStart("run-1", null));
		await session.appendEntry(assistantEntry("a1", ["call-1"]), "main");

		const result = await repairInterruptedOperation(session);
		strictEqual(result.appendedEntries, 1);

		const messages = await session.findEntries({ type: "message", order: "oldestFirst" });
		const repaired = messages.at(-1) as MessageEntry;
		strictEqual(repaired.id, "interrupted-tool-result-call-1-2");
		expect(repaired.message).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			isError: true,
			content: [{ type: "text", text: TOOL_NOT_STARTED_TEXT }],
		});
		strictEqual((await session.findOpenOperations("main")).length, 0);
	});

	it("reuses resultEntryId and warns when a started tool has unknown outcome", async () => {
		const session = await createSession();
		await session.appendRecord(runStart("run-1", null));
		await session.appendEntry(assistantEntry("a1", ["call-1"]), "main");
		await session.appendRecord({
			type: "tool_started",
			id: "tool-started-1",
			lane: "main",
			runId: "run-1",
			assistantEntryId: "a1",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "tool-call-1",
			effectiveArgs: {},
			resultEntryId: "result-1",
			replay: "never",
		});

		await repairInterruptedOperation(session);

		const repaired = (await session.getEntry("result-1")) as MessageEntry;
		expect(repaired.message).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			isError: true,
			content: [{ type: "text", text: TOOL_OUTCOME_UNKNOWN_TEXT }],
		});
	});

	it("keeps durable real results and only repairs unanswered calls in transcript order", async () => {
		const session = await createSession();
		await session.appendRecord(runStart("run-1", null));
		await session.appendEntry(assistantEntry("a1", ["call-1", "call-2"]), "main");
		await session.appendEntry(toolResultEntry("result-1", "call-1"), "main");

		await repairInterruptedOperation(session);

		const toolResults = (await session.findEntries({ type: "message", order: "oldestFirst" }))
			.filter(isToolResultEntry)
			.map((entry) => entry.message.toolCallId);
		deepStrictEqual(toolResults, ["call-1", "call-2"]);
	});

	it("refuses two open operations without appending", async () => {
		const appended: unknown[] = [];
		const store: RepairSessionStore = {
			findOpenOperations: async () => [
				{ ...runStart("run-2", null), seq: 2, timestamp: 1 },
				{ ...runStart("run-1", null), seq: 1, timestamp: 1 },
			],
			appendEntry: async <TEntry extends Entry>(entry: ProvisionedEntry<TEntry>) => {
				appended.push(entry);
				return { ...entry, seq: 1, parentId: null, timestamp: 1 } as unknown as TEntry;
			},
			appendRecord: async <TRecord extends NewRecord>(record: TRecord) => {
				appended.push(record);
				return { ...record, seq: 1, timestamp: 1 } as TRecord & Pick<RecordBase, "seq" | "timestamp">;
			},
			findEntriesOnBranch: async () => [],
			findRecords: async () => [],
			getEntry: async () => undefined,
			getLanes: async () => [{ lane: "main", leafId: null }],
		};
		await expect(repairInterruptedOperation(store)).rejects.toBeInstanceOf(SessionError);
		deepStrictEqual(appended, []);
	});

	it("adds replay-safe guidance only for replay-safe tool starts", async () => {
		const session = await createSession();
		await session.appendRecord(runStart("run-1", null));
		await session.appendEntry(assistantEntry("a1", ["call-1"]), "main");
		await session.appendRecord({
			type: "tool_started",
			id: "tool-started-1",
			lane: "main",
			runId: "run-1",
			assistantEntryId: "a1",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "tool-call-1",
			effectiveArgs: {},
			resultEntryId: "result-1",
			replay: "safe",
		});

		await repairInterruptedOperation(session);

		const repaired = (await session.getEntry("result-1")) as MessageEntry;
		const content = repaired.message.role === "toolResult" ? repaired.message.content[0] : undefined;
		const text = content?.type === "text" ? content.text : "";
		expect(text).toContain(TOOL_OUTCOME_UNKNOWN_TEXT);
		expect(text).toContain("replay-safe");
	});

	it("is idempotent after repairing once", async () => {
		const session = await createSession();
		await session.appendRecord(runStart("run-1", null));
		await session.appendEntry(assistantEntry("a1", ["call-1"]), "main");

		await repairInterruptedOperation(session);
		const once = await session.getLog();
		await repairInterruptedOperation(session);
		deepStrictEqual(await session.getLog(), once);
	});

	it("skips trailing aborted/error assistant entries during context derivation", async () => {
		const session = await createSession();
		await session.appendEntry(userEntry("u1"), "main");
		const abortedAssistant = assistantEntry("a1", []);
		if (abortedAssistant.message.role !== "assistant") throw new Error("expected assistant fixture");
		await session.appendEntry(
			{
				...abortedAssistant,
				message: { ...abortedAssistant.message, stopReason: "aborted" },
			},
			"main",
		);
		const entries = await session.findEntries({ order: "oldestFirst" });
		const context = buildRepairSafeSessionContext(entries);
		deepStrictEqual(
			context.messages.map((message) => message.role),
			["user"],
		);
	});
});

function isToolResultEntry(entry: Entry): entry is MessageEntry & { message: { role: "toolResult"; toolCallId: string } } {
	return entry.type === "message" && entry.message.role === "toolResult";
}
