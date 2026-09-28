import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			"sdk/packages/core/vitest.config.ts",
			"sdk/packages/llms/vitest.config.ts",
			"sdk/packages/shared/vitest.config.ts",
			"apps/vscode/vitest.config.ts",
		],
	},
});
