import type { AgentMessage } from "../vendor/pi/types.ts";

// Durable add/revoke entries fold deterministically from raw branch history.
import type { CustomEntry, Entry, SessionTree } from "../vendor/pi/harness/session/types.ts";

export const CONSTRAINT_ADD_TYPE = "constraint/add";
export const CONSTRAINT_REVOKE_TYPE = "constraint/revoke";

export interface Constraint {
	id: string;
	text: string;
	firstAddSeq: number;
}

export class ConstraintError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConstraintError";
	}
}

export function assertConstraintAddData(data: unknown): asserts data is { id: string; text: string } {
	if (
		typeof data !== "object" ||
		data === null ||
		typeof (data as { id?: unknown }).id !== "string" ||
		typeof (data as { text?: unknown }).text !== "string" ||
		(data as { id: string }).id.length === 0 ||
		(data as { text: string }).text.length === 0
	) {
		throw new ConstraintError("constraint/add data must be { id: string, text: string }");
	}
}

export function assertConstraintRevokeData(data: unknown): asserts data is { id: string } {
	if (
		typeof data !== "object" ||
		data === null ||
		typeof (data as { id?: unknown }).id !== "string" ||
		(data as { id: string }).id.length === 0
	) {
		throw new ConstraintError("constraint/revoke data must be { id: string }");
	}
}

function assertConstraintEntry(entry: CustomEntry): void {
	if (entry.customType === CONSTRAINT_ADD_TYPE) assertConstraintAddData(entry.data);
	else if (entry.customType === CONSTRAINT_REVOKE_TYPE) assertConstraintRevokeData(entry.data);
}

export function foldConstraints(pathEntries: readonly Entry[]): Constraint[] {
	const firstAddSeqById = new Map<string, number>();
	const active = new Map<string, Constraint>();

	for (const entry of pathEntries) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== CONSTRAINT_ADD_TYPE && entry.customType !== CONSTRAINT_REVOKE_TYPE) continue;
		try {
			assertConstraintEntry(entry);
		} catch (error) {
			throw new ConstraintError(
				`Malformed ${entry.customType} entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (entry.customType === CONSTRAINT_ADD_TYPE) {
			assertConstraintAddData(entry.data);
			const data = entry.data;
			const firstAddSeq = firstAddSeqById.get(data.id) ?? entry.seq;
			firstAddSeqById.set(data.id, firstAddSeq);
			active.set(data.id, { id: data.id, text: data.text, firstAddSeq });
		} else {
			assertConstraintRevokeData(entry.data);
			active.delete(entry.data.id);
		}
	}

	return [...active.values()].toSorted((left, right) => left.firstAddSeq - right.firstAddSeq || left.id.localeCompare(right.id));
}

export function renderConstraintSection(constraints: readonly Constraint[]): string {
	if (constraints.length === 0) return "";
	const lines = [
		"<session-constraints>",
		"These user constraints are durable instructions for every request in this session:",
		...constraints.map((constraint) => `- ${constraint.text}`),
		"</session-constraints>",
	];
	return lines.join("\n");
}

export function constraintSectionMessage(constraints: readonly Constraint[], timestamp = 0): AgentMessage[] {
	const rendered = renderConstraintSection(constraints);
	if (!rendered) return [];
	return [{ role: "user", content: [{ type: "text", text: rendered }], timestamp }];
}

export function constraintEntryProjector(): AgentMessage[] {
	return [];
}

export interface ConstraintTree
	extends Pick<SessionTree, "getLeafId" | "findEntriesOnBranch" | "appendCustomEntry"> {}

export async function foldActiveConstraints(tree: Pick<SessionTree, "getLeafId" | "findEntriesOnBranch">): Promise<Constraint[]> {
	const leafId = await tree.getLeafId();
	if (leafId === null) return [];
	const pathEntries = await tree.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
	return foldConstraints(pathEntries);
}

export async function renderActiveConstraintSection(
	tree: Pick<SessionTree, "getLeafId" | "findEntriesOnBranch">,
): Promise<string> {
	return renderConstraintSection(await foldActiveConstraints(tree));
}

export async function appendConstraint(tree: ConstraintTree, id: string, text: string): Promise<string> {
	assertConstraintAddData({ id, text });
	const active = await foldActiveConstraints(tree);
	if (active.some((constraint) => constraint.id === id)) {
		throw new ConstraintError(`Constraint is already active: ${id}`);
	}
	return tree.appendCustomEntry(CONSTRAINT_ADD_TYPE, { id, text });
}

export async function revokeConstraint(tree: ConstraintTree, id: string): Promise<string> {
	assertConstraintRevokeData({ id });
	const active = await foldActiveConstraints(tree);
	if (!active.some((constraint) => constraint.id === id)) {
		throw new ConstraintError(`Constraint is not active: ${id}`);
	}
	return tree.appendCustomEntry(CONSTRAINT_REVOKE_TYPE, { id });
}
