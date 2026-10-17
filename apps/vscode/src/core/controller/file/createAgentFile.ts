import { resolveAgentLocations, workspaceAgentsDir } from "@core/context/instructions/user-instructions/configured-agents"
import { buildConfiguredAgentToolName } from "@plinycode/core"
import { CreateAgentRequest, RefreshedAgents } from "@shared/proto/cline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath } from "@/utils/fs"
import type { Controller } from ".."
import { openFile } from "./openFile"
import { buildRefreshedAgents } from "./refreshAgents"

/**
 * A new agent file. `name` and `description` are required; the other fields
 * are commented out with what leaving them out means, so the file loads as it
 * is and the user uncomments what they need.
 */
const AGENT_TEMPLATE = `---
# The model sees this agent as the {{TOOL_NAME}} tool.
name: {{AGENT_NAME}}
# What the agent does and when to use it. The model reads this to decide when to call it.
description: Describe what this agent does and when the main agent should hand it a task.
# Tools it may use, by name; leave out for all of the conversation's tools.
# tools: read_files, search_codebase, find_files
# Skills it may load with the skills tool.
# skills: my-skill
# Provider and model it runs on; leave out to use the conversation's.
# providerId: pliny
# modelId: <a model id from the model picker>
# Most model calls per run; leave out for the plinycode.subagents.maxIterations setting.
# maxIterations: 40
---
You are {{AGENT_NAME}}, a sub-agent working for the main agent.

Describe its role, how it should work and what its final report must contain.
The task it receives is all it knows of the conversation.
`

/** The name as a file name: letters, digits, dashes and underscores. */
function sanitizeAgentName(name: string): string {
	return name
		.trim()
		.replace(/[^a-zA-Z0-9_-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
}

function renderAgentTemplate(name: string): string {
	return AGENT_TEMPLATE.replace(/\{\{AGENT_NAME\}\}/g, name).replace(/\{\{TOOL_NAME\}\}/g, buildConfiguredAgentToolName(name))
}

/**
 * Creates `<name>.md` in the workspace's `.cline/agents` (or the global agents
 * folder) from the template and opens it. An existing file is opened instead.
 */
export async function createAgentFile(controller: Controller, request: CreateAgentRequest): Promise<RefreshedAgents> {
	const { agentName, isGlobal } = request
	if (!agentName || typeof agentName !== "string" || typeof isGlobal !== "boolean") {
		Logger.error("createAgentFile: Missing or invalid parameters", { agentName, isGlobal })
		throw new Error("Missing or invalid parameters for createAgentFile")
	}
	const name = sanitizeAgentName(agentName)
	if (!name) {
		throw new Error("Invalid agent name")
	}

	let agentsDir: string
	if (isGlobal) {
		agentsDir = resolveAgentLocations(undefined).globalDir
	} else {
		const primaryWorkspace = (await HostProvider.workspace.getWorkspacePaths({})).paths[0]
		if (!primaryWorkspace) {
			throw new Error("No workspace folder open")
		}
		agentsDir = workspaceAgentsDir(primaryWorkspace)
	}

	const filePath = path.join(agentsDir, `${name}.md`)
	if (await fileExistsAtPath(filePath)) {
		await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: `Agent "${name}" already exists`,
		})
	} else {
		await fs.mkdir(agentsDir, { recursive: true })
		await fs.writeFile(filePath, renderAgentTemplate(name), "utf-8")
	}
	await openFile(controller, { value: filePath })

	return buildRefreshedAgents(controller)
}
