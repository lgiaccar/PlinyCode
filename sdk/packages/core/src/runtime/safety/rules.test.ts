import { describe, expect, it } from "vitest";
import type {
	RuleConfig,
	UserInstructionConfigWatcher,
} from "../../extensions/config/user-instruction-config-loader";
import {
	describeRuleScope,
	formatRulesForSystemPrompt,
	listEnabledRulesFromWatcher,
	mergeRulesForSystemPrompt,
} from "./rules";

function rule(
	name: string,
	frontmatter: Record<string, unknown> = {},
): RuleConfig {
	return { name, instructions: `${name} body`, frontmatter };
}

describe("mergeRulesForSystemPrompt", () => {
	it("returns additional rules when watcher rules are absent", () => {
		expect(mergeRulesForSystemPrompt(undefined, "inline rules")).toBe(
			"inline rules",
		);
	});

	it("returns watcher rules when inline rules are absent", () => {
		expect(mergeRulesForSystemPrompt("watcher rules", undefined)).toBe(
			"watcher rules",
		);
	});

	it("appends inline rules after watcher rules", () => {
		expect(mergeRulesForSystemPrompt("watcher rules", "inline rules")).toBe(
			"watcher rules\n\ninline rules",
		);
	});
});

describe("describeRuleScope", () => {
	it("reports Copilot applyTo, Cursor globs and Cline paths as file globs", () => {
		expect(describeRuleScope(rule("a", { applyTo: "**/*.py" }))).toBe(
			"Applies only when working with files matching: `**/*.py`",
		);
		expect(describeRuleScope(rule("b", { globs: "*.tsx, src/**/*.ts" }))).toBe(
			"Applies only when working with files matching: `*.tsx`, `src/**/*.ts`",
		);
		expect(describeRuleScope(rule("c", { paths: ["docs/**"] }))).toBe(
			"Applies only when working with files matching: `docs/**`",
		);
	});

	it("treats catch-all globs and alwaysApply rules as unscoped", () => {
		expect(describeRuleScope(rule("a", { applyTo: "**" }))).toBeUndefined();
		expect(
			describeRuleScope(rule("b", { globs: "*.ts", alwaysApply: true })),
		).toBeUndefined();
		expect(describeRuleScope(rule("c"))).toBeUndefined();
	});

	it("describes Cursor agent-requested rules by their description", () => {
		expect(
			describeRuleScope(
				rule("a", { alwaysApply: false, description: "Database migrations" }),
			),
		).toBe("Apply only when relevant: Database migrations");
	});

	it("renders the scope under the rule heading", () => {
		expect(
			formatRulesForSystemPrompt([rule("py", { applyTo: "**/*.py" })]),
		).toBe(
			"\n\n# Rules\n## py\n_Applies only when working with files matching: `**/*.py`_\n\npy body",
		);
	});
});

describe("listEnabledRulesFromWatcher", () => {
	it("drops rules whose file the host filter rejects", () => {
		const records = new Map([
			["keep", { filePath: "/w/keep.md", item: rule("keep") }],
			["drop", { filePath: "/w/drop.md", item: rule("drop") }],
			[
				"disabled",
				{
					filePath: "/w/disabled.md",
					item: { ...rule("disabled"), disabled: true },
				},
			],
		]);
		const watcher = {
			getSnapshot: () => records,
		} as unknown as UserInstructionConfigWatcher;

		expect(
			listEnabledRulesFromWatcher(
				watcher,
				(filePath) => filePath !== "/w/drop.md",
			).map((item) => item.name),
		).toEqual(["keep"]);
		expect(
			listEnabledRulesFromWatcher(watcher).map((item) => item.name),
		).toEqual(["drop", "keep"]);
	});
});
