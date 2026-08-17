import { describe, expect, it } from "vitest";
import { buildSessionContext } from "../vendor/pi/harness/session/context.ts";
import type { Entry } from "../vendor/pi/harness/session/types.ts";
import {
	CONSTRAINT_ADD_TYPE,
	CONSTRAINT_REVOKE_TYPE,
	ConstraintError,
	appendConstraint,
	constraintEntryProjector,
	foldActiveConstraints,
	foldConstraints,
	renderConstraintSection,
	revokeConstraint,
} from "../src/constraints.ts";
import { InMemorySessionRepo } from "../vendor/pi/harness/session/memory.ts";

function custom(id: string, seq: number, customType: string, data: unknown, timestamp = 1000 - seq): Entry {
	return { type: "custom", id, seq, parentId: seq === 1 ? null : `e${seq - 1}`, timestamp, customType, data };
}

describe("constraints", () => {
	it("folds last-wins constraints by seq and ignores timestamps", () => {
		const entries = [
			custom("e1", 1, CONSTRAINT_ADD_TYPE, { id: "a", text: "Never use library A" }),
			custom("e2", 2, CONSTRAINT_REVOKE_TYPE, { id: "a" }),
			custom("e3", 3, CONSTRAINT_ADD_TYPE, { id: "a", text: "Never use library A again" }),
			custom("e4", 4, CONSTRAINT_ADD_TYPE, { id: "b", text: "Never call service B" }),
			custom("e5", 5, CONSTRAINT_REVOKE_TYPE, { id: "b" }),
		];

		expect(foldConstraints(entries)).toEqual([{ id: "a", text: "Never use library A again", firstAddSeq: 1 }]);
	});

	it("renders deterministic constraint section in first-add order", () => {
		const rendered = renderConstraintSection([
			{ id: "b", text: "Second", firstAddSeq: 20 },
			{ id: "a", text: "First", firstAddSeq: 10 },
		].toSorted((left, right) => left.firstAddSeq - right.firstAddSeq));

		expect(rendered).toBe(
			[
				"<session-constraints>",
				"These user constraints are durable instructions for every request in this session:",
				"- First",
				"- Second",
				"</session-constraints>",
			].join("\n"),
		);
	});

	it("does not project raw constraint entries into transcript messages", () => {
		const context = buildSessionContext(
			[custom("e1", 1, CONSTRAINT_ADD_TYPE, { id: "a", text: "Never use A" })],
			{ entryProjectors: { [CONSTRAINT_ADD_TYPE]: constraintEntryProjector } },
		);

		expect(context.messages).toEqual([]);
	});

	it("fails closed on malformed constraint data", () => {
		expect(() => foldConstraints([custom("e1", 1, CONSTRAINT_ADD_TYPE, { id: "a" })])).toThrow(ConstraintError);
	});

	it("rejects duplicate adds and unknown revokes before appending", async () => {
		const session = await new InMemorySessionRepo().create({ id: "constraint-api" });
		await appendConstraint(session, "a", "First");
		await expect(appendConstraint(session, "a", "Duplicate")).rejects.toThrow("already active");
		await expect(revokeConstraint(session, "missing")).rejects.toThrow("not active");
		expect(await session.findEntries({ type: "custom" })).toHaveLength(1);

		await revokeConstraint(session, "a");
		await appendConstraint(session, "replacement", "Second");
		expect(await foldActiveConstraints(session)).toEqual([
			expect.objectContaining({ id: "replacement", text: "Second" }),
		]);
	});
});
