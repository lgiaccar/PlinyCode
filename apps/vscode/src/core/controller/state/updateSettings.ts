import { setCompactionStrategyGlobally, setModelToolEnabledGlobally } from "@plinycode/core"
import { Empty } from "@shared/proto/cline/common"
import { PlanActMode, McpDisplayMode as ProtoMcpDisplayMode, UpdateSettingsRequest } from "@shared/proto/cline/state"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import { OpenaiReasoningEffort } from "@shared/storage/types"
import { ClineEnv } from "@/config"
import { setPrereleaseChannelEnabled } from "@/hosts/vscode/auto-update/update-settings"
import { setConversationSpendingLimit } from "@/hosts/vscode/spending-settings"
import { McpDisplayMode } from "@/shared/McpDisplayMode"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { createTaskApiModelShim, resolveActiveModelIdFromApiConfiguration } from "../models/taskApiModel"

/**
 * Updates multiple extension settings in a single request
 * @param controller The controller instance
 * @param request The request containing the settings to update
 * @returns An empty response
 */
export async function updateSettings(controller: Controller, request: UpdateSettingsRequest): Promise<Empty> {
	try {
		if (request.clineEnv !== undefined && request.clineEnv !== "") {
			ClineEnv.setEnvironment(request.clineEnv)
		}

		if (request.apiConfiguration) {
			const protoApiConfiguration = request.apiConfiguration

			const convertedApiConfigurationFromProto = {
				...protoApiConfiguration,
				// Convert proto ApiProvider enums to native string types
				planModeApiProvider: protoApiConfiguration.planModeApiProvider
					? convertProtoToApiProvider(protoApiConfiguration.planModeApiProvider)
					: undefined,
				actModeApiProvider: protoApiConfiguration.actModeApiProvider
					? convertProtoToApiProvider(protoApiConfiguration.actModeApiProvider)
					: undefined,
				planModeReasoningEffort: protoApiConfiguration.planModeReasoningEffort as OpenaiReasoningEffort | undefined,
				actModeReasoningEffort: protoApiConfiguration.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
			}

			controller.stateManager.setApiConfiguration(convertedApiConfigurationFromProto)

			if (controller.task) {
				const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
				const modelId = resolveActiveModelIdFromApiConfiguration(convertedApiConfigurationFromProto, currentMode)
				controller.task.api = createTaskApiModelShim(modelId)
			}
		}

		// Update plan/act separate models setting
		if (request.planActSeparateModelsSetting !== undefined) {
			controller.stateManager.setGlobalState("planActSeparateModelsSetting", request.planActSeparateModelsSetting)
		}

		// Update checkpoints setting
		if (request.enableCheckpointsSetting !== undefined) {
			controller.stateManager.setGlobalState("enableCheckpointsSetting", request.enableCheckpointsSetting)
		}

		// Update MCP responses collapsed setting
		if (request.mcpResponsesCollapsed !== undefined) {
			controller.stateManager.setGlobalState("mcpResponsesCollapsed", request.mcpResponsesCollapsed)
		}

		// Update the user-dragged max height (in rows) for the chat prompt textarea
		if (request.chatInputMaxRows !== undefined) {
			controller.stateManager.setGlobalState("chatInputMaxRows", request.chatInputMaxRows)
		}

		// Update MCP display mode setting
		if (request.mcpDisplayMode !== undefined) {
			// Convert proto enum to string type
			let displayMode: McpDisplayMode
			switch (request.mcpDisplayMode) {
				case ProtoMcpDisplayMode.RICH:
					displayMode = "rich"
					break
				case ProtoMcpDisplayMode.PLAIN:
					displayMode = "plain"
					break
				case ProtoMcpDisplayMode.MARKDOWN:
					displayMode = "markdown"
					break
				default:
					throw new Error(`Invalid MCP display mode value: ${request.mcpDisplayMode}`)
			}
			controller.stateManager.setGlobalState("mcpDisplayMode", displayMode)
		}

		if (request.mode !== undefined) {
			const mode = request.mode === PlanActMode.PLAN ? "plan" : "act"
			controller.stateManager.setGlobalState("mode", mode)
		}

		if (request.preferredLanguage !== undefined) {
			controller.stateManager.setGlobalState("preferredLanguage", request.preferredLanguage)
		}

		// Update terminal timeout setting
		if (request.shellIntegrationTimeout !== undefined) {
			controller.stateManager.setGlobalState("shellIntegrationTimeout", Number(request.shellIntegrationTimeout))
			controller.terminalManager?.setShellIntegrationTimeout(Number(request.shellIntegrationTimeout))
		}

		// Update terminal reuse setting
		if (request.terminalReuseEnabled !== undefined) {
			controller.stateManager.setGlobalState("terminalReuseEnabled", request.terminalReuseEnabled)
			controller.terminalManager?.setTerminalReuseEnabled(!!request.terminalReuseEnabled)
		}

		if (request.vscodeTerminalExecutionMode !== undefined && request.vscodeTerminalExecutionMode !== "") {
			const previousMode = controller.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
			const nextMode = request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
			controller.stateManager.setGlobalState("vscodeTerminalExecutionMode", nextMode)
			controller.handleTerminalExecutionModeChanged(previousMode, nextMode)
		}

		if (request.hooksEnabled !== undefined) {
			controller.stateManager.setGlobalState("hooksEnabled", !!request.hooksEnabled)
		}
		// Update subagents setting
		if (request.subagentsEnabled !== undefined) {
			controller.stateManager.setGlobalState("subagentsEnabled", !!request.subagentsEnabled)
		}

		// Update auto-condense setting
		if (request.useAutoCondense !== undefined) {
			controller.stateManager.setGlobalState("useAutoCondense", request.useAutoCondense)
		}

		// Update web search setting (stored in the SDK global settings file; applied when the next session is built)
		if (request.webSearchEnabled !== undefined) {
			setModelToolEnabledGlobally("web_search", !!request.webSearchEnabled)
		}

		// Stored as the plinycode.updates.prerelease VS Code setting, which the auto-updater watches
		if (request.prereleaseUpdatesEnabled !== undefined) {
			await setPrereleaseChannelEnabled(request.prereleaseUpdatesEnabled)
		}

		// Stored as the plinycode.spending.conversationLimit VS Code setting; read before every model call
		if (request.conversationSpendingLimit !== undefined) {
			await setConversationSpendingLimit(request.conversationSpendingLimit)
		}

		if (request.compactionStrategy !== undefined) {
			const strategy = request.compactionStrategy
			if (strategy !== "basic" && strategy !== "agentic") {
				throw new Error(`Invalid compaction strategy value: ${strategy}`)
			}
			setCompactionStrategyGlobally(strategy)
		}

		// Update default terminal profile
		if (request.defaultTerminalProfile !== undefined) {
			controller.stateManager.setGlobalState("defaultTerminalProfile", request.defaultTerminalProfile)
			// Update the live terminal manager so new terminals use the new profile.
			// Existing terminals are left open — they're keyed by effective shell
			// and reused when compatible, or skipped when not. No session rebuild
			// is needed: the run_commands tool re-reads the profile each time a
			// model request is built, so the description and execution both pick
			// up the new shell at the next request boundary.
			controller.terminalManager?.setDefaultTerminalProfile(request.defaultTerminalProfile)
		}

		if (request.backgroundEditEnabled !== undefined) {
			controller.stateManager.setGlobalState("backgroundEditEnabled", !!request.backgroundEditEnabled)
		}

		if (request.multiRootEnabled !== undefined) {
			controller.stateManager.setGlobalState("multiRootEnabled", !!request.multiRootEnabled)
		}

		if (request.showFeatureTips !== undefined) {
			controller.stateManager.setGlobalState("showFeatureTips", request.showFeatureTips)
		}

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error("Failed to update settings:", error)
		throw error
	}
}
