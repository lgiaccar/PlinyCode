import { Boolean, type StringRequest } from "@shared/proto/cline/common"
import { getDevOpsServerControl } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

/** Asks for and stores a personal access token for an Azure DevOps Server (`request.value` is its host, or empty). */
export async function signInAdoServer(_controller: Controller, request: StringRequest): Promise<Boolean> {
	const control = getDevOpsServerControl()
	if (!control) {
		throw new Error("The PlinyCode DevOps server is not available in this build.")
	}
	return Boolean.create({ value: await control.signInAdoServer(request.value || undefined) })
}
