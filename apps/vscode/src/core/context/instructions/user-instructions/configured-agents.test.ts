import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AgentToggleSource, isAgentEnabled, listConfiguredAgents, withDisabledAgentPolicies } from "./configured-agents"

function agentFile(name: string, extra = ""): string {
	return `---\nname: ${name}\ndescription: Does ${name} work\n${extra}---\nYou are ${name}.\n`
}

function toggles(local: Record<string, boolean> = {}, global: Record<string, boolean> = {}): AgentToggleSource {
	return {
		getGlobalSettingsKey: () => global,
		getWorkspaceStateKey: () => local,
	}
}

describe("configured agents", () => {
	let root: string
	let workspaceDir: string
	let globalDir: string
	let locations: { searchPaths: string[]; globalDir: string }

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "agents-tab-"))
		workspaceDir = path.join(root, "repo", ".cline", "agents")
		globalDir = path.join(root, "home", ".cline", "agents")
		mkdirSync(workspaceDir, { recursive: true })
		mkdirSync(globalDir, { recursive: true })
		writeFileSync(path.join(workspaceDir, "reviewer.md"), agentFile("reviewer", "providerId: pliny\nmodelId: some-model\n"))
		writeFileSync(path.join(workspaceDir, "broken.md"), "no frontmatter here")
		writeFileSync(path.join(globalDir, "Test Writer.md"), agentFile("Test Writer"))
		locations = { searchPaths: [workspaceDir, globalDir], globalDir }
	})

	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
	})

	it("lists workspace and global agents with their tool names, models and load errors", () => {
		const agents = listConfiguredAgents(path.join(root, "repo"), toggles(), locations)
		expect(agents.map(({ name, scope, toolName, model, enabled }) => ({ name, scope, toolName, model, enabled }))).toEqual([
			{ name: "broken", scope: "workspace", toolName: "", model: "", enabled: true },
			{ name: "reviewer", scope: "workspace", toolName: "subagent_reviewer", model: "pliny/some-model", enabled: true },
			{ name: "Test Writer", scope: "global", toolName: "subagent_test_writer", model: "", enabled: true },
		])
		expect(agents[0].error).toMatch(/frontmatter/i)
		expect(agents[1].description).toBe("Does reviewer work")
	})

	it("reads a toggle from either map, whatever the path's case on Windows", () => {
		const reviewer = path.join(workspaceDir, "reviewer.md")
		expect(isAgentEnabled(reviewer, toggles({ [reviewer]: false }))).toBe(false)
		expect(isAgentEnabled(reviewer, toggles({}, { [reviewer]: false }))).toBe(false)
		expect(isAgentEnabled(reviewer, toggles({ [reviewer]: true }))).toBe(true)
		if (process.platform === "win32") {
			expect(isAgentEnabled(reviewer, toggles({ [reviewer.toUpperCase()]: false }))).toBe(false)
		}
	})

	it("disables a switched-off agent's tool and keeps the session's other policies", () => {
		const reviewer = path.join(workspaceDir, "reviewer.md")
		const base = { spawn_agent: { autoApprove: false } }
		expect(withDisabledAgentPolicies(base, path.join(root, "repo"), toggles(), locations)).toBeUndefined()
		expect(withDisabledAgentPolicies(base, path.join(root, "repo"), toggles({ [reviewer]: false }), locations)).toEqual({
			spawn_agent: { autoApprove: false },
			subagent_reviewer: { enabled: false },
		})
	})

	it("disables a global agent switched off in the global map, without session policies", () => {
		const writer = path.join(globalDir, "Test Writer.md")
		expect(withDisabledAgentPolicies(undefined, undefined, toggles({}, { [writer]: false }), locations)).toEqual({
			subagent_test_writer: { enabled: false },
		})
	})
})
