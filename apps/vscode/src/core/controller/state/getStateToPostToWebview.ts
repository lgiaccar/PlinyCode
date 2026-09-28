// Extracted from classic src/core/controller/index.ts (see origin/main)
//
// Standalone function to build ExtensionState from a Controller instance.
// This allows the SdkController to reuse the classic state-building logic
// without inheriting the entire classic Controller implementation.

import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { isModelToolEnabledGlobally, readCompactionStrategyGlobally } from "@plinycode/core"
import type { ExtensionState, Platform } from "@shared/ExtensionMessage"
import { ClineEnv } from "@/config"
import { isPrereleaseChannelEnabled } from "@/hosts/vscode/auto-update/update-settings"
import { getConversationSpendingLimit } from "@/hosts/vscode/spending-settings"
import { ExtensionRegistryInfo } from "@/registry"
import { getDistinctId } from "@/services/logging/distinctId"
import { PLINY_DEFAULT_MODEL_ID, PLINY_PROVIDER_ID } from "@/shared/pliny"

/**
 * Builds the ExtensionState object to push to the webview.
 * Extracted from the classic Controller.getStateToPostToWebview().
 */
export async function getStateToPostToWebview(controller: {
	task?: any
	stateManager: any
	mcpHub?: any
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	foregroundCommandRunning?: boolean
	workspaceManager?: any
	checkpointRestoreInput?: ExtensionState["checkpointRestoreInput"]
	editMessageRestartFocus?: ExtensionState["editMessageRestartFocus"]
}): Promise<ExtensionState> {
	const stateManager = controller.stateManager

	// Get API configuration from cache for immediate access
	const rawApiConfiguration = stateManager.getApiConfiguration()
	const apiConfiguration = {
		...rawApiConfiguration,
		planModeApiProvider: PLINY_PROVIDER_ID,
		actModeApiProvider: PLINY_PROVIDER_ID,
		planModeApiModelId: rawApiConfiguration.planModeApiModelId || PLINY_DEFAULT_MODEL_ID,
		actModeApiModelId: rawApiConfiguration.actModeApiModelId || PLINY_DEFAULT_MODEL_ID,
	}
	// Persist the pin so legacy Cline/OpenRouter selections cannot resurface.
	if (
		rawApiConfiguration.planModeApiProvider !== PLINY_PROVIDER_ID ||
		rawApiConfiguration.actModeApiProvider !== PLINY_PROVIDER_ID
	) {
		stateManager.setApiConfiguration(apiConfiguration)
	}
	const taskHistory = stateManager.getGlobalStateKey("taskHistory")
	const autoApprovalSettings = stateManager.getGlobalSettingsKey("autoApprovalSettings")
	const preferredLanguage = stateManager.getGlobalSettingsKey("preferredLanguage")
	const mode = stateManager.getGlobalSettingsKey("mode")
	const useAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense")
	const compactionStrategy = readCompactionStrategyGlobally()
	const webSearchEnabled = isModelToolEnabledGlobally("web_search")
	const prereleaseUpdatesEnabled = isPrereleaseChannelEnabled()
	const conversationSpendingLimit = getConversationSpendingLimit()
	const subagentsEnabled = stateManager.getGlobalSettingsKey("subagentsEnabled")
	const userInfo = stateManager.getGlobalStateKey("userInfo")
	const mcpDisplayMode = stateManager.getGlobalStateKey("mcpDisplayMode")
	const planActSeparateModelsSetting = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
	const enableCheckpointsSetting = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
	const globalClineRulesToggles = stateManager.getGlobalStateKey("globalClineRulesToggles")
	const globalWorkflowToggles = stateManager.getGlobalStateKey("globalWorkflowToggles")
	const globalSkillsToggles = stateManager.getGlobalStateKey("globalSkillsToggles")
	const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles")
	const shellIntegrationTimeout = stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
	const terminalReuseEnabled = stateManager.getGlobalStateKey("terminalReuseEnabled")
	const vscodeTerminalExecutionMode = stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
	const defaultTerminalProfile = stateManager.getGlobalSettingsKey("defaultTerminalProfile")
	const isNewUser = stateManager.getGlobalStateKey("isNewUser")
	// PlinyCode: no Cline account/onboarding — always treat welcome as completed.
	const welcomeViewCompleted = true
	if (!stateManager.getGlobalStateKey("welcomeViewCompleted")) {
		stateManager.setGlobalState("welcomeViewCompleted", true)
	}
	const mcpResponsesCollapsed = stateManager.getGlobalStateKey("mcpResponsesCollapsed")
	const chatInputMaxRows = stateManager.getGlobalStateKey("chatInputMaxRows")
	const favoritedModelIds = stateManager.getGlobalStateKey("favoritedModelIds")
	const showFeatureTips = stateManager.getGlobalSettingsKey("showFeatureTips")

	const localClineRulesToggles = stateManager.getWorkspaceStateKey("localClineRulesToggles")
	const localWindsurfRulesToggles = stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
	const localCursorRulesToggles = stateManager.getWorkspaceStateKey("localCursorRulesToggles")
	const localAgentsRulesToggles = stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
	const localCopilotRulesToggles = stateManager.getWorkspaceStateKey("localCopilotRulesToggles")
	const workflowToggles = stateManager.getWorkspaceStateKey("workflowToggles")

	const currentTaskItem = controller.task?.taskId
		? (taskHistory || []).find((item: any) => item.id === controller.task?.taskId)
		: undefined
	const clineMessages = [...(controller.task?.messageStateHandler?.getClineMessages?.() || [])]
	const checkpointRestoreInput = controller.checkpointRestoreInput
	const editMessageRestartFocus = controller.editMessageRestartFocus

	const processedTaskHistory = (taskHistory || [])
		.filter((item: any) => item.ts && item.task)
		.sort((a: any, b: any) => b.ts - a.ts)
		.slice(0, 100)

	const platform = process.platform as Platform
	const distinctId = getDistinctId()
	const version = ExtensionRegistryInfo.version
	const clineConfig = ClineEnv.config()
	const environment = clineConfig.environment

	return {
		version,
		apiConfiguration,
		currentTaskItem,
		clineMessages,
		checkpointRestoreInput,
		editMessageRestartFocus,
		autoApprovalSettings,
		preferredLanguage,
		mode,
		useAutoCondense,
		compactionStrategy,
		webSearchEnabled,
		prereleaseUpdatesEnabled,
		conversationSpendingLimit,
		subagentsEnabled,
		userInfo,
		mcpDisplayMode,
		planActSeparateModelsSetting,
		enableCheckpointsSetting: enableCheckpointsSetting ?? true,
		platform,
		environment,
		distinctId,
		globalClineRulesToggles: globalClineRulesToggles || {},
		localClineRulesToggles: localClineRulesToggles || {},
		localWindsurfRulesToggles: localWindsurfRulesToggles || {},
		localCursorRulesToggles: localCursorRulesToggles || {},
		localAgentsRulesToggles: localAgentsRulesToggles || {},
		localCopilotRulesToggles: localCopilotRulesToggles || {},
		localWorkflowToggles: workflowToggles || {},
		globalWorkflowToggles: globalWorkflowToggles || {},
		globalSkillsToggles: globalSkillsToggles || {},
		localSkillsToggles: localSkillsToggles || {},
		shellIntegrationTimeout,
		terminalReuseEnabled,
		vscodeTerminalExecutionMode,
		defaultTerminalProfile,
		isNewUser,
		welcomeViewCompleted,
		mcpResponsesCollapsed,
		chatInputMaxRows,
		taskHistory: processedTaskHistory,
		favoritedModelIds,
		backgroundCommandRunning: controller.backgroundCommandRunning ?? false,
		backgroundCommandTaskId: controller.backgroundCommandTaskId,
		foregroundCommandRunning: controller.foregroundCommandRunning ?? false,
		workspaceRoots: controller.workspaceManager?.getRoots?.() ?? [],
		primaryRootIndex: controller.workspaceManager?.getPrimaryIndex?.() ?? 0,
		isMultiRootWorkspace: (controller.workspaceManager?.getRoots?.()?.length ?? 0) > 1,
		hooksEnabled: getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled")),
		backgroundEditEnabled: stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
		showFeatureTips,
	} as ExtensionState
}
