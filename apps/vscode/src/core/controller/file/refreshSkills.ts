import { estimateFileTokens } from "@core/context/instructions/user-instructions/instruction-tokens"
import { type CoreSettingsItem, createCoreSettingsService } from "@plinycode/core"
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
		warnings: skill.warnings ?? [],
	})
}

/**
 * Refreshes all skill toggles (discovers skills and their enabled state)
 */
export async function refreshSkills(_controller: Controller): Promise<RefreshedSkills> {
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

	return RefreshedSkills.create({
		globalSkills,
		localSkills,
	})
}
