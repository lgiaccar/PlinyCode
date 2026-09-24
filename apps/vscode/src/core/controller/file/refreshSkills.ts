import { estimateFileTokens } from "@core/context/instructions/user-instructions/instruction-tokens"
import { parseRemoteSkillEntries } from "@core/context/instructions/user-instructions/skills"
import { type CoreSettingsItem, createCoreSettingsService } from "@plinycode/core"
import { estimateTokens } from "@plinycode/shared"
import { RefreshedSkills, SkillInfo } from "@shared/proto/cline/file"
import { HostProvider } from "@/hosts/host-provider"
import { Controller } from ".."

async function coreSkillToSkillInfo(skill: CoreSettingsItem): Promise<SkillInfo> {
	return SkillInfo.create({
		name: skill.name,
		description: skill.description ?? "",
		path: skill.path,
		enabled: skill.enabled !== false,
		tokens: skill.path ? await estimateFileTokens(skill.path) : 0,
	})
}

/**
 * Refreshes all skill toggles (discovers skills and their enabled state)
 */
export async function refreshSkills(controller: Controller): Promise<RefreshedSkills> {
	// Get workspace paths for local skills
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	const primaryWorkspace = workspacePaths.paths[0]

	const settingsSnapshot = await createCoreSettingsService().list({
		workspaceRoot: primaryWorkspace,
	})
	const globalSkills = await Promise.all(
		settingsSnapshot.skills
			.filter((skill) => skill.source === "global" || skill.source === "global-plugin")
			.map(coreSkillToSkillInfo),
	)
	const localSkills = await Promise.all(
		settingsSnapshot.skills
			.filter((skill) => skill.source === "workspace" || skill.source === "workspace-plugin")
			.map(coreSkillToSkillInfo),
	)

	// Add remote skills from remote config.
	// Precedence: remote (enterprise) > disk-global (user) > project (workspace).
	// Remote entries are appended to globalSkills[] and split into the dedicated "Enterprise Skills"
	// section by the UI. The toggle store distinguishes them by the "remote:" path prefix.
	const remoteConfigSettings = controller.stateManager.getRemoteConfigSettings()
	const remoteSkillsToggles = controller.stateManager.getGlobalStateKey("remoteSkillsToggles") || {}
	const validatedRemoteSkills = parseRemoteSkillEntries(remoteConfigSettings.remoteGlobalSkills || [])

	for (const entry of validatedRemoteSkills) {
		const enabled = entry.alwaysEnabled || remoteSkillsToggles[entry.name] !== false

		globalSkills.push(
			SkillInfo.create({
				name: entry.name,
				description: entry.description,
				path: `remote:${entry.name}`,
				enabled,
				alwaysEnabled: entry.alwaysEnabled,
				tokens: estimateTokens(entry.contents.length),
			}),
		)
	}

	return RefreshedSkills.create({
		globalSkills,
		localSkills,
	})
}
