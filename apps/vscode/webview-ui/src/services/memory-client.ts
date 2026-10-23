import type { MemoryPanelState } from "@shared/memory-panel"
import { StringRequest } from "@shared/proto/cline/common"
import { TaskServiceClient } from "./grpc-client"

export async function memoryRequest(input: Record<string, unknown> = {}): Promise<MemoryPanelState> {
	const result = await TaskServiceClient.manageMemory(StringRequest.create({ value: JSON.stringify(input) }))
	if (input.action && input.action !== "read") window.dispatchEvent(new Event("pliny-memory-changed"))
	return JSON.parse(result.value) as MemoryPanelState
}
