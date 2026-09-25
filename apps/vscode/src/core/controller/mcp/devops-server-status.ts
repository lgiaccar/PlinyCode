import { DevOpsServerStatus } from "@shared/proto/cline/mcp"
import type { DevOpsServerStatus as Status } from "@/services/devops-mcp/builtin-mcp-registry"

/** Status reported while the extension has not started the DevOps service (e.g. standalone builds). */
export const UNAVAILABLE_DEVOPS_STATUS = DevOpsServerStatus.create({
	state: "error",
	error: "The PlinyCode DevOps server is not available in this build.",
	editor: "",
	integration: "none",
})

export function toProtoDevOpsStatus(status: Status): DevOpsServerStatus {
	return DevOpsServerStatus.create({
		state: status.state,
		error: status.error,
		tools: status.tools,
		editor: status.editor,
		integration: status.integration,
		editorRegistered: status.editorRegistered,
		editorError: status.editorError,
		enabled: status.enabled,
		registerWithEditor: status.registerWithEditor,
	})
}
