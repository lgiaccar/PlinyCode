import { Empty, type EmptyRequest } from "@shared/proto/cline/common"
import { ShowMessageType } from "@shared/proto/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { getDevOpsServerControl } from "@/services/devops-mcp/builtin-mcp-registry"
import { writeTextToClipboard } from "@/utils/env"
import type { Controller } from "../index"

/** Copies an `mcpServers` config for MCP clients PlinyCode cannot register with directly. */
export async function copyDevOpsServerConfig(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	const control = getDevOpsServerControl()
	if (!control) {
		return Empty.create()
	}
	await writeTextToClipboard(await control.manualConfig())
	HostProvider.window.showMessage({
		type: ShowMessageType.INFORMATION,
		message:
			"PlinyCode DevOps MCP config copied. Paste the entry into your client's MCP config (e.g. ~/.cursor/mcp.json). It signs in with `gh` / `az` or GITHUB_TOKEN / AZURE_DEVOPS_PAT.",
	})
	return Empty.create()
}
