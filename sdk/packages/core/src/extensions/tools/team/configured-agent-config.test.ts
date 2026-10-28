import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadConfiguredAgentConfigs,
	parseConfiguredAgentConfig,
} from "./configured-agent-config";

describe("configured agent config parser", () => {
	it("parses YAML frontmatter and system prompt body", () => {
		const config = parseConfiguredAgentConfig(`---
name: code-reviewer
description: Reviews code
tools: execute_command, read_file
skills:
  - review-pr
modelId: anthropic/claude-sonnet-4.6
---
You are a code reviewer.`);

		expect(config).toMatchObject({
			name: "code-reviewer",
			description: "Reviews code",
			tools: ["execute_command", "read_file"],
			skills: ["review-pr"],
			modelId: "anthropic/claude-sonnet-4.6",
			systemPrompt: "You are a code reviewer.",
		});
	});

	it("parses frontmatter when the content starts with a UTF-8 BOM", () => {
		const config = parseConfiguredAgentConfig(`\uFEFF---
name: code-reviewer
description: Reviews code
---
You are a code reviewer.`);

		expect(config).toMatchObject({
			name: "code-reviewer",
			description: "Reviews code",
			systemPrompt: "You are a code reviewer.",
		});
	});

	it("does not treat delimiter lines in the body as frontmatter delimiters", () => {
		const config = parseConfiguredAgentConfig(`---
name: code-reviewer
description: Reviews code
tools: read_file
---
Prompt body
---
More prompt`);

		expect(config.systemPrompt).toBe("Prompt body\n---\nMore prompt");
	});

	it.each([
		["empty", ""],
		["comment-only", "# comment"],
		["scalar", "code-reviewer"],
	])("rejects %s frontmatter candidates without hanging", (_name, yaml) => {
		expect(() =>
			parseConfiguredAgentConfig(`---
${yaml}
---
You are a code reviewer.`),
		).toThrow("Missing closing YAML frontmatter delimiter");
	});

	it("uses the file basename (without extension) when name is absent from frontmatter", () => {
		const config = parseConfiguredAgentConfig(
			`---
description: Reviews code
---
You are a code reviewer.`,
			{ path: "/workspace/.github/agents/code-review.agent.md" },
		);
		expect(config.name).toBe("code-review");
	});

	it("strips compound extensions like .agent.md to derive the name", () => {
		const config = parseConfiguredAgentConfig(
			`---
description: FM developer agent
---
You are an FM developer.`,
			{ path: "/workspace/.github/agents/fm-agents/fm-dev.agent.md" },
		);
		expect(config.name).toBe("fm-dev");
	});

	it("uses 'unnamed' when no path is provided and name is absent", () => {
		const config = parseConfiguredAgentConfig(`---
description: Some agent
---
You are an agent.`);
		expect(config.name).toBe("unnamed");
	});

	it("uses empty string as description when description is absent", () => {
		const config = parseConfiguredAgentConfig(
			`---
name: my-agent
---
You are an agent.`,
		);
		expect(config.description).toBe("");
	});

	it("falls back to the plain .md basename for single extension", () => {
		const config = parseConfiguredAgentConfig(
			`---
description: A reviewer
---
You are a reviewer.`,
			{ path: "/agents/reviewer.md" },
		);
		expect(config.name).toBe("reviewer");
	});
});

describe("loadConfiguredAgentConfigs — subdirectory recursion", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agents-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const makeAgent = (name: string) =>
		`---\nname: ${name}\ndescription: Agent ${name}\n---\nYou are ${name}.`;

	const makeAgentNoName = (description: string) =>
		`---\ndescription: ${description}\n---\nYou are an agent.`;

	it("loads agent files directly in the search directory", () => {
		writeFileSync(join(tmpDir, "top.md"), makeAgent("top-agent"));
		const { configs, errors } = loadConfiguredAgentConfigs({
			searchPaths: [tmpDir],
		});
		expect(errors).toEqual([]);
		expect(configs.map((c) => c.name)).toContain("top-agent");
	});

	it("loads agent files one level inside a subdirectory", () => {
		const subDir = join(tmpDir, "fm-agents");
		mkdirSync(subDir);
		writeFileSync(
			join(subDir, "fm-dev.agent.md"),
			makeAgentNoName("FM developer"),
		);
		const { configs, errors } = loadConfiguredAgentConfigs({
			searchPaths: [tmpDir],
		});
		expect(errors).toEqual([]);
		expect(configs.map((c) => c.name)).toContain("fm-dev");
	});

	it("loads agents from both the top directory and its subdirectories", () => {
		writeFileSync(join(tmpDir, "top.md"), makeAgent("top-agent"));
		const subDir = join(tmpDir, "sub");
		mkdirSync(subDir);
		writeFileSync(join(subDir, "sub-agent.md"), makeAgent("sub-agent"));
		const { configs, errors } = loadConfiguredAgentConfigs({
			searchPaths: [tmpDir],
		});
		expect(errors).toEqual([]);
		const names = configs.map((c) => c.name);
		expect(names).toContain("top-agent");
		expect(names).toContain("sub-agent");
	});

	it("does not recurse deeper than one level", () => {
		const sub = join(tmpDir, "level1");
		const subsub = join(sub, "level2");
		mkdirSync(sub);
		mkdirSync(subsub);
		writeFileSync(join(subsub, "deep.md"), makeAgent("deep-agent"));
		const { configs } = loadConfiguredAgentConfigs({ searchPaths: [tmpDir] });
		expect(configs.map((c) => c.name)).not.toContain("deep-agent");
	});

	it("deduplicates: a name from the top directory shadows the same name in a subdirectory", () => {
		writeFileSync(join(tmpDir, "reviewer.md"), makeAgent("reviewer"));
		const subDir = join(tmpDir, "extra");
		mkdirSync(subDir);
		writeFileSync(join(subDir, "reviewer.md"), makeAgent("reviewer"));
		const { configs } = loadConfiguredAgentConfigs({ searchPaths: [tmpDir] });
		expect(configs.filter((c) => c.name === "reviewer")).toHaveLength(1);
	});
});
