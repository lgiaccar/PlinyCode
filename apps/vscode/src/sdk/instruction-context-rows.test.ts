import type { CoreSessionConfig } from "@plinycode/core"
import type { AgentModelRequest } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import {
	formatInstructionContextRow,
	installInstructionContextRows,
	summarizeInstructionContext,
} from "./instruction-context-rows"

const SYSTEM_PROMPT = `You are PlinyCode.

# Rules
## Workspace AGENTS.md
Use bun.

## .cursor/rules/git.md
Never force-push.

## Rules to read when they apply
These rule files are not included above.
- **profile-nsight** (Apply only when relevant: CUDA profiling): \`d:/repo/.cursor/rules/profile-nsight.mdc\`
- **python** (Applies only when working with files matching: \`**/*.py\`): \`d:/repo/.github/instructions/python.md\`

# Plan / Act Modes
Some text.`

function request(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
	return {
		systemPrompt: SYSTEM_PROMPT,
		messages: [],
		tools: [
			{ name: "read_files", description: "Read files.", inputSchema: {} },
			{
				name: "skills",
				description:
					"Execute a skill. Available skills: build-skill (Build GPUSurfer with the wrapper scripts); grilling; azure-mcp (Use the Azure MCP server (docs, CLI)).",
				inputSchema: {},
			},
		],
		...overrides,
	}
}

describe("summarizeInstructionContext", () => {
	it("reads inline rules, on-demand rules and skills off the request", () => {
		expect(summarizeInstructionContext(request())).toMatchObject({
			inlineRules: ["Workspace AGENTS.md", ".cursor/rules/git.md"],
			onDemandRules: ["profile-nsight", "python"],
			skills: ["build-skill", "grilling", "azure-mcp"],
		})
	})

	it("counts every rule when a rule's nested headings and code blocks look like sections", () => {
		// What the engine sends for a rule whose body opens with `# Title`:
		// headings nested under the rule, fenced code left as written.
		const systemPrompt = [
			"You are PlinyCode.",
			"",
			"# Rules",
			"## .cursor/rules/ai-output.mdc",
			"### Agent Output Directory",
			"#### Do",
			"```bash",
			"# not a section",
			"## not a rule",
			"```",
			"",
			"## .cursor/rules/code-generation.mdc",
			"### Code Generation",
			"",
			"## Workspace AGENTS.md",
			"Use bun.",
			"",
			"# Plan / Act Modes",
			"## Not a rule",
		].join("\n")
		const summary = summarizeInstructionContext(request({ systemPrompt }))
		expect(summary.inlineRules).toEqual([
			".cursor/rules/ai-output.mdc",
			".cursor/rules/code-generation.mdc",
			"Workspace AGENTS.md",
		])
		expect(summary.rulesChars).toBeGreaterThan(100)
	})

	it("reports nothing when the prompt has no rules and no skills tool", () => {
		const summary = summarizeInstructionContext(request({ systemPrompt: "You are PlinyCode.", tools: [] }))
		expect(summary).toMatchObject({ inlineRules: [], onDemandRules: [], skills: [] })
		expect(formatInstructionContextRow(summary)).toBe("Context: no rules or skills were loaded for this workspace.")
	})

	it("formats one row with counts, a few names and a +N tail", () => {
		const text = formatInstructionContextRow({
			inlineRules: ["AGENTS.md"],
			onDemandRules: [],
			skills: ["a", "b", "c", "d", "e", "f", "g"],
		})
		expect(text).toBe("Context: 1 rule in the prompt: `AGENTS.md` · 7 skills: `a`, `b`, `c`, `d`, `e` +2 more")
	})

	it("reports the memory section, whose nested headings do not end it early", () => {
		const memory =
			"# Memory\n\nYou have a memory.\n\n## Repository memory\n\n### Repository memory: x\n\n#### Notes\n\n- a fact"
		const rules = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("# Rules"))
		const summary = summarizeInstructionContext(request({ systemPrompt: `You are PlinyCode.\n\n${memory}\n${rules}` }))
		expect(summary.memoryChars).toBe(memory.length - "# Memory\n".length)
		expect(summary.inlineRules).toEqual(["Workspace AGENTS.md", ".cursor/rules/git.md"])
		expect(formatInstructionContextRow({ inlineRules: [], onDemandRules: [], skills: [], memoryChars: 4000 })).toBe(
			"Context: memory (~1k tokens)",
		)
	})

	it("adds the approximate size when known", () => {
		const text = formatInstructionContextRow({
			inlineRules: ["AGENTS.md"],
			onDemandRules: [],
			skills: ["a"],
			rulesChars: 26_800,
			skillsChars: 400,
		})
		expect(text).toBe("Context: 1 rule in the prompt (~6.7k tokens): `AGENTS.md` · 1 skill (~100 tokens): `a`")
	})
})

describe("installInstructionContextRows", () => {
	it("emits a row for the root agent when the set changes, and stays silent for sub-agents", async () => {
		const rows: string[] = []
		let ts = 0
		const config = installInstructionContextRows(
			{ hooks: { beforeModel: async () => ({ options: { marker: true } }) } } as unknown as CoreSessionConfig,
			{ emitRow: (message) => rows.push(message.text ?? ""), nextMessageTs: () => ++ts },
		)
		const root = { snapshot: { agentId: "root" } as never, request: request() }

		const result = await config.hooks?.beforeModel?.(root)
		expect(result).toEqual({ options: { marker: true } })
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatch(/2 rules in the prompt \(~\d+ tokens\): `Workspace AGENTS\.md`, `\.cursor\/rules\/git\.md`/)
		expect(rows[0]).toContain("2 rules to read when relevant")
		expect(rows[0]).toMatch(/3 skills \(~\d+ tokens\): `build-skill`, `grilling`, `azure-mcp`/)

		// Same set on the next call of the turn: no second row.
		await config.hooks?.beforeModel?.(root)
		expect(rows).toHaveLength(1)

		// A sub-agent never reports.
		await config.hooks?.beforeModel?.({
			snapshot: { agentId: "sub", parentAgentId: "root" } as never,
			request: request({ tools: [] }),
		})
		expect(rows).toHaveLength(1)

		// The set changed (a skill was disabled): one more row.
		await config.hooks?.beforeModel?.({ ...root, request: request({ tools: [] }) })
		expect(rows).toHaveLength(2)
		expect(rows[1]).not.toContain("skills")
	})
})
