import { HookInfo, HooksToggles, WorkspaceHooks } from "@shared/proto/cline/file"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { type HookFile, type HookFileListing, listHookFiles } from "../../hooks/hook-files"
import { type HookToggleState, isHookFileToggledOn } from "../../hooks/hook-toggles"
import { Controller } from ".."

/** The hook files the engine discovers for this window's workspace folders. */
export async function listWindowHookFiles(): Promise<HookFileListing> {
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	return listHookFiles(workspacePaths.paths)
}

/** The Hooks tab's listing, with each file's toggle. */
export function toHooksToggles(state: HookToggleState, listing: HookFileListing): HooksToggles {
	const toHookInfo = (file: HookFile) =>
		HookInfo.create({
			name: file.name,
			enabled: isHookFileToggledOn(state, file.absolutePath),
			absolutePath: file.absolutePath,
		})
	return HooksToggles.create({
		globalHooks: listing.global.map(toHookInfo),
		// Every workspace folder is listed, even without hooks, so the first
		// hook can be created from its dropdown.
		workspaceHooks: listing.workspaces.map((workspace) =>
			WorkspaceHooks.create({
				workspaceName: path.basename(workspace.workspacePath),
				hooks: workspace.files.map(toHookInfo),
			}),
		),
		isWindows: process.platform === "win32",
	})
}

export async function refreshHooks(controller: Controller, _request?: unknown): Promise<HooksToggles> {
	return toHooksToggles(controller.stateManager, await listWindowHookFiles())
}
