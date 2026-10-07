import { type EmptyRequest, String } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import type { Controller } from "../index"

/** Opens a file picker for a CI board prompt file; returns its path, or "" when cancelled. */
export async function pickCiPromptFile(_controller: Controller, _request: EmptyRequest): Promise<String> {
	const { paths } = await HostProvider.window.showOpenDialogue({
		canSelectMany: false,
		canSelectFiles: true,
		canSelectFolders: false,
		openLabel: "Use as prompt",
		filters: { files: ["md", "txt", "prompt"] },
	})
	return String.create({ value: paths[0] ?? "" })
}
