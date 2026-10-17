import { describe, expect, it } from "vitest";
import {
	getCoreBuiltinToolCatalog,
	getCoreDefaultEnabledToolIds,
	getCoreHeadlessToolNames,
	resolveCoreSelectedToolIds,
} from "./runtime";

describe("builtin tool catalog", () => {
	it("includes the spawn entry", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(catalog.some((entry) => entry.id === "spawn_agent")).toBe(true);
	});

	it("includes the unified tasks tool outside yolo mode", () => {
		for (const mode of ["act", "plan"] as const) {
			const entry = getCoreBuiltinToolCatalog({ mode }).find(
				(candidate) => candidate.id === "tasks",
			);
			expect(entry).toMatchObject({
				defaultEnabled: true,
				headlessToolNames: ["tasks"],
			});
		}
		expect(
			getCoreBuiltinToolCatalog({ mode: "yolo" }).some(
				(entry) => entry.id === "tasks",
			),
		).toBe(false);
		expect(
			getCoreBuiltinToolCatalog({ mode: "act", clientType: "cli" }).some(
				(entry) => entry.id === "tasks",
			),
		).toBe(false);
		expect(
			getCoreBuiltinToolCatalog({ mode: "act", clientType: "vscode" }).some(
				(entry) => entry.id === "tasks",
			),
		).toBe(false);
	});

	it("marks spawn enabled by default in act mode", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(
			catalog.find((entry) => entry.id === "spawn_agent")?.defaultEnabled,
		).toBe(true);
	});

	it("marks spawn disabled by default in yolo mode", () => {
		const catalog = getCoreBuiltinToolCatalog({ mode: "yolo" });
		expect(
			catalog.find((entry) => entry.id === "spawn_agent")?.defaultEnabled,
		).toBe(false);
	});

	it("expands headless tool names for selected entries", () => {
		const names = getCoreHeadlessToolNames(
			new Set(["spawn_agent", "read_files"]),
			{ mode: "act" },
		);
		expect(names).toContain("read_files");
		expect(names).toContain("spawn_agent");
	});

	it("uses a single editor catalog entry and maps to apply_patch when routed", () => {
		const actCatalog = getCoreBuiltinToolCatalog({ mode: "act" });
		expect(actCatalog.some((entry) => entry.id === "apply_patch")).toBe(false);
		expect(
			actCatalog.find((entry) => entry.id === "editor")?.headlessToolNames,
		).toEqual(["editor"]);

		const gptCatalog = getCoreBuiltinToolCatalog({
			mode: "act",
			modelId: "openai/gpt-5.4",
			providerId: "openai",
		});
		expect(
			gptCatalog.find((entry) => entry.id === "editor")?.headlessToolNames,
		).toEqual(["apply_patch"]);
		expect(gptCatalog.some((entry) => entry.id === "submit_and_exit")).toBe(
			false,
		);
	});

	it("resolves default selected ids from the catalog", () => {
		const selected = resolveCoreSelectedToolIds({
			enabled: true,
			availabilityContext: { mode: "act" },
		});
		expect(selected.has("spawn_agent")).toBe(true);
		expect(getCoreDefaultEnabledToolIds({ mode: "act" })).toContain(
			"spawn_agent",
		);
	});

	it("surfaces native web search only for supported model selections", () => {
		const anthropic = getCoreBuiltinToolCatalog({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		expect(
			anthropic.find((entry) => entry.id === "web_search")?.defaultEnabled,
		).toBe(false);

		const enabled = getCoreBuiltinToolCatalog({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			enabledModelToolIds: new Set(["web_search"]),
		});
		expect(
			enabled.find((entry) => entry.id === "web_search")?.defaultEnabled,
		).toBe(true);

		const unsupported = getCoreBuiltinToolCatalog({
			providerId: "ollama",
			modelId: "llama3",
		});
		expect(unsupported.some((entry) => entry.id === "web_search")).toBe(false);
	});
});
