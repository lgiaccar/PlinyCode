import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatRulesForSystemPrompt,
	listEnabledRulesFromWatcher,
} from "../../runtime/safety/rules";
import {
	discoverNestedGuideFiles,
	isNestedGuideFile,
	nestedGuideRule,
} from "./nested-guides";
import { createUserInstructionConfigWatcher } from "./user-instruction-config-loader";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.map((root) => rm(root, { recursive: true, force: true })),
	);
	roots.length = 0;
});

async function workspace(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "nested-guides-")));
	roots.push(root);
	await writeFile(join(root, "AGENTS.md"), "# Root guide\nUse bun.");
	await writeFile(join(root, "CLAUDE.md"), "# Claude guide\nSee AGENTS.md.");
	await mkdir(join(root, "apps", "vscode"), { recursive: true });
	await writeFile(
		join(root, "apps", "vscode", "AGENTS.md"),
		"# Extension guide\nRun check-types.",
	);
	await mkdir(join(root, "sdk"), { recursive: true });
	await writeFile(join(root, "sdk", "AGENTS.md"), "# Engine guide\nBuild sdk.");
	await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
	await writeFile(join(root, "node_modules", "pkg", "AGENTS.md"), "vendored");
	await mkdir(join(root, ".git", "x"), { recursive: true });
	await writeFile(join(root, ".git", "x", "AGENTS.md"), "hidden");
	await mkdir(join(root, "a", "b", "c", "d"), { recursive: true });
	await writeFile(join(root, "a", "b", "c", "d", "AGENTS.md"), "too deep");
	return root;
}

describe("nested agent guides", () => {
	it("finds guides below the root, shallowest first, skipping dependencies, hidden and too-deep folders", async () => {
		const root = await workspace();
		expect(discoverNestedGuideFiles(root)).toEqual([
			join(root, "CLAUDE.md"),
			join(root, "sdk", "AGENTS.md"),
			join(root, "apps", "vscode", "AGENTS.md"),
		]);
		expect(discoverNestedGuideFiles(root, { maxFiles: 1 })).toHaveLength(1);
		expect(isNestedGuideFile(join(root, "AGENTS.md"), root)).toBe(false);
		expect(isNestedGuideFile(join(root, "sdk", "AGENTS.md"), root)).toBe(true);
		expect(isNestedGuideFile(join(root, "sdk", "README.md"), root)).toBe(false);
	});

	it("scopes a nested guide to its folder, keeps a scope the guide sets, and lists a root CLAUDE.md on demand", () => {
		const root = "/repo";
		expect(nestedGuideRule("/repo/apps/vscode/AGENTS.md", root, {})).toEqual({
			name: "apps/vscode/AGENTS.md",
			frontmatter: { paths: ["apps/vscode/**"] },
		});
		expect(
			nestedGuideRule("/repo/sdk/AGENTS.md", root, { globs: "sdk/**/*.ts" }),
		).toEqual({ name: "sdk/AGENTS.md", frontmatter: { globs: "sdk/**/*.ts" } });
		const claude = nestedGuideRule("/repo/CLAUDE.md", root, {});
		expect(claude.name).toBe("CLAUDE.md");
		expect(claude.frontmatter).toMatchObject({ alwaysApply: false });
	});

	it("puts the root guide inline first and lists the nested ones by path", async () => {
		const root = await workspace();
		await mkdir(join(root, ".clinerules"), { recursive: true });
		await writeFile(join(root, ".clinerules", "a-style.md"), "Tabs.");
		const watcher = createUserInstructionConfigWatcher({
			skills: { directories: [] },
			rules: { workspacePath: root },
			workflows: { directories: [] },
		});
		try {
			await watcher.refreshAll();
			const rules = listEnabledRulesFromWatcher(watcher);
			expect(rules[0]?.name).toBe("Workspace AGENTS.md");
			const prompt = formatRulesForSystemPrompt(rules);
			expect(prompt).toContain("## Workspace AGENTS.md");
			expect(prompt).toContain("Use bun.");
			expect(prompt.indexOf("Use bun.")).toBeLessThan(prompt.indexOf("Tabs."));
			// Nested guides are listed with their scope, not inlined.
			expect(prompt).not.toContain("Run check-types.");
			expect(prompt).toContain(
				"- **apps/vscode/AGENTS.md** (Applies only when working with files matching: `apps/vscode/**`)",
			);
			expect(prompt).toContain("- **sdk/AGENTS.md**");
			expect(prompt).toContain("- **CLAUDE.md** (Apply only when relevant:");
			expect(prompt).not.toContain("vendored");
		} finally {
			watcher.stop();
		}
	});
});
