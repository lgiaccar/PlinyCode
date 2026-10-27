import { RuleScope, type SkillInfo } from "@shared/proto/cline/file"
import { FileServiceClient } from "@/services/grpc-client"
import type { BulkToggleTarget } from "./BulkToggleControl"

type ToggleMap = Record<string, boolean>

const targetsFor = (toggles: ToggleMap, toggle: (path: string, enabled: boolean) => Promise<unknown>): BulkToggleTarget[] =>
	Object.entries(toggles).map(([path, enabled]) => ({ enabled, toggle: (next) => toggle(path, next) }))

export const ruleBulkTargets = (maps: {
	globalClineRulesToggles: ToggleMap
	localClineRulesToggles: ToggleMap
	localCursorRulesToggles: ToggleMap
	localWindsurfRulesToggles: ToggleMap
	localAgentsRulesToggles: ToggleMap
	localCopilotRulesToggles: ToggleMap
}): BulkToggleTarget[] => [
	...targetsFor(maps.globalClineRulesToggles, (rulePath, enabled) =>
		FileServiceClient.toggleClineRule({ metadata: {}, scope: RuleScope.GLOBAL, rulePath, enabled }),
	),
	...targetsFor(maps.localClineRulesToggles, (rulePath, enabled) =>
		FileServiceClient.toggleClineRule({ metadata: {}, scope: RuleScope.LOCAL, rulePath, enabled }),
	),
	...targetsFor(maps.localCursorRulesToggles, (rulePath, enabled) =>
		FileServiceClient.toggleCursorRule({ metadata: {}, rulePath, enabled }),
	),
	...targetsFor(maps.localWindsurfRulesToggles, (rulePath, enabled) =>
		FileServiceClient.toggleWindsurfRule({ metadata: {}, rulePath, enabled }),
	),
	...targetsFor(maps.localAgentsRulesToggles, (rulePath, enabled) =>
		FileServiceClient.toggleAgentsRule({ metadata: {}, rulePath, enabled }),
	),
	...targetsFor(maps.localCopilotRulesToggles, (rulePath, enabled) =>
		FileServiceClient.toggleCopilotRule({ metadata: {}, rulePath, enabled }),
	),
]

export const skillBulkTargets = (globalSkills: SkillInfo[], localSkills: SkillInfo[]): BulkToggleTarget[] =>
	[
		...globalSkills.map((skill) => ({ skill, isGlobal: true })),
		...localSkills.map((skill) => ({ skill, isGlobal: false })),
	].map(({ skill, isGlobal }) => ({
		enabled: skill.enabled,
		toggle: (enabled) => FileServiceClient.toggleSkill({ metadata: {}, skillPath: skill.path, isGlobal, enabled }),
	}))
