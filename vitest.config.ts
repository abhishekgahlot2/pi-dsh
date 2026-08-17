import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["upstream/**", "vendor/**", "node_modules/**"],
	},
});
