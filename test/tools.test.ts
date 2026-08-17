import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../vendor/pi/harness/env/nodejs.ts";
import { createDefaultTools } from "../src/tools.ts";

describe("createDefaultTools", () => {
	it("binds Pi's four standard tools to one explicit execution environment", () => {
		const tools = createDefaultTools({ env: new NodeExecutionEnv({ cwd: "/tmp" }) });

		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
	});
});
