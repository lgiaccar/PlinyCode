import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { buildToolPolicies, isSubAgentDeniedTool, isSubAgentTool, isToolAutoApproved } from "./sdk-tool-policies"

describe("sub-agent tools", () => {
	it("follows the Delegate to sub-agents toggle, on by default and for settings saved before it existed", () => {
		expect(isToolAutoApproved("spawn_agent", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(true)
		expect(isToolAutoApproved("subagent_reviewer", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(true)
		const legacy = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions } }
		delete legacy.actions.useSubagents
		expect(isToolAutoApproved("spawn_agent", legacy)).toBe(true)
		const off = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useSubagents: false },
		}
		expect(isToolAutoApproved("spawn_agent", off)).toBe(false)
		expect(buildToolPolicies(DEFAULT_AUTO_APPROVAL_SETTINGS).spawn_agent).toEqual({ autoApprove: false })
	})

	it("names the tools a sub-agent does not get", () => {
		expect(isSubAgentTool("spawn_agent")).toBe(true)
		expect(isSubAgentTool("subagent_code_reviewer")).toBe(true)
		expect(isSubAgentTool("read_files")).toBe(false)
		for (const denied of ["ask_advisor", "save_memory", "search_conversations", "read_conversation"]) {
			expect(isSubAgentDeniedTool(denied)).toBe(true)
		}
		for (const allowed of ["run_commands", "wait", "update_todo_list", "github__get_pull_request"]) {
			expect(isSubAgentDeniedTool(allowed)).toBe(false)
		}
	})
})

describe("isToolAutoApproved", () => {
	it("does not auto-approve command tools by default", () => {
		expect(isToolAutoApproved("run_commands", DEFAULT_AUTO_APPROVAL_SETTINGS)).toBe(false)
	})

	it("uses executeSafeCommands as the single command approval flag", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
				executeSafeCommands: false,
				executeAllCommands: true,
			},
		}

		expect(isToolAutoApproved("run_commands", settings)).toBe(false)
	})

	it("approves saving a memory like a file edit and conversation search like a file read", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: true, editFiles: false },
		}
		expect(isToolAutoApproved("save_memory", settings)).toBe(false)
		expect(isToolAutoApproved("search_conversations", settings)).toBe(true)
		expect(isToolAutoApproved("read_conversation", settings)).toBe(true)
		const policies = buildToolPolicies(settings)
		expect(policies.save_memory).toEqual({ autoApprove: false })
		expect(policies.search_conversations).toEqual({ autoApprove: false })
	})

	it("auto-approves all MCP tools when the Use MCP servers toggle is on", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: true },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(true)
	})

	it("prompts for MCP tools when the Use MCP servers toggle is off", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useMcp: false },
		}

		expect(isToolAutoApproved("firecrawl__scrape", settings)).toBe(false)
	})
})
