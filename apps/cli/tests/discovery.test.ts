import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discover } from "../src/discovery";
import { parseOptions } from "../src/options";

const root = resolve(import.meta.dir, "../../../ai_output");
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(join(root, "discovery-"));
afterAll(() => rm(scratch, { recursive: true, force: true, maxRetries: 5 }));
async function file(path: string, content: string) {
	const target = join(scratch, path);
	await mkdir(resolve(target, ".."), { recursive: true });
	await writeFile(target, content);
}

test("workspace discovery reuses editor folders, disabled skills, warnings, and nested agents", async () => {
	await file(
		".github/skills/review/SKILL.md",
		"---\nname: review\ndescription: Review tests\n---\nUse evidence.",
	);
	await file(
		".cursor/skills/off.mdc",
		"---\nname: off\ndisabled: true\n---\nDisabled.",
	);
	await file(
		".claude/agents/team/auditor.agent.md",
		"---\ndescription: Audit tests\n---\nAudit evidence.",
	);
	await file(".cline/agents/broken.md", "Not an agent");
	const loaded = await discover(parseOptions(["skills", "--cwd", scratch]));
	try {
		expect(loaded.skills.map((s) => s.name)).toContain("review");
		expect(loaded.skills.find((s) => s.name === "off")?.disabled).toBe(true);
		expect(loaded.agents[0].name).toBe("auditor");
		expect(loaded.errors).toHaveLength(1);
		expect(
			[...loaded.skillsDirs, ...loaded.agentsDirs].every((p) =>
				p.startsWith(scratch),
			),
		).toBe(true);
	} finally {
		loaded.instructions.stop();
	}
});

test("explicit folders replace defaults, resolve from cwd and support spaces", async () => {
	await file(
		"my skills/one/SKILL.md",
		"---\nname: only\ndescription: Explicit skill\n---\nBe precise.",
	);
	await file("my agents/only.md", "---\nname: only-agent\n---\nBe precise.");
	const loaded = await discover(
		parseOptions([
			"agents",
			"--cwd",
			scratch,
			"--skills-dir",
			"my skills",
			"--agents-dir",
			"my agents",
		]),
	);
	try {
		expect(loaded.skills.map((s) => s.name)).toEqual(["only"]);
		expect(loaded.agents.map((s) => s.name)).toEqual(["only-agent"]);
		expect(loaded.errors).toEqual([]);
	} finally {
		loaded.instructions.stop();
	}
});

test("bad explicitly supplied folders fail instead of silently falling back", async () => {
	await expect(
		discover(
			parseOptions(["skills", "--cwd", scratch, "--skills-dir", "missing"]),
		),
	).rejects.toThrow("Configuration directory");
});
