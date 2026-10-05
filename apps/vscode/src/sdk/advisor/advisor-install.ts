/**
 * Wires the advisor tool (`advisor-tool.ts`) into a session's `CoreSessionConfig`.
 *
 * The tool is added to every root session and hidden from the model, call by
 * call, whenever the conversation is not offered it (`advisorUnavailableReason`).
 * A session's tool list is fixed when it starts, while the setting and the
 * conversation's model can both change under a running session: hiding the
 * tool per call follows them without a session rebuild.
 *
 * Sub-agents never get it: core builds their tool list from its built-in
 * tools only, not from `extraTools`.
 */

import type { CoreSessionConfig } from "@plinycode/core"
import type { ModelInfo } from "@plinycode/llms"
import type { AgentModel } from "@plinycode/shared"
import { isPlinyRouterModelId } from "@shared/pliny"
import { getSessionState } from "../router/router-health"
import { ADVISOR_TOOL_NAME, type AdvisorSettings, advisorUnavailableReason } from "./advisor-settings"
import { type AdvisorCallLedger, type AdvisorUsage, createAdvisorTool } from "./advisor-tool"

export interface AdvisorInstallDeps {
	getSettings: () => AdvisorSettings
	/** See `AdvisorToolDeps.checkBudget`. */
	checkBudget: (sessionId: string) => Promise<string | undefined>
	/** See `AdvisorToolDeps.onUsage`. */
	onUsage?: (sessionId: string, usage: AdvisorUsage) => void
	/** The key the router keeps this session's state under (`installRouter`'s `sessionId`). */
	routerSessionKey?: string
	ledger?: AdvisorCallLedger
	timeoutMs?: number
}

export function installAdvisor(config: CoreSessionConfig, deps: AdvisorInstallDeps): CoreSessionConfig {
	// The advisor needs a gateway model on the session's connection, and the
	// model factory is the only place one can be built. It also reports the
	// model each run starts on, which a mid-conversation switch changes.
	let createModel: ((modelId: string) => AgentModel) | undefined
	let runModelId: string | undefined
	let knownModels = config.knownModels as Record<string, ModelInfo> | undefined
	const baseFactory = config.agentModelFactory
	config.agentModelFactory = (input) => {
		// Core copies the factory into sub-agents; only the root run counts.
		if (!input.config.parentAgentId) {
			createModel = (modelId) => input.createDefault({ modelId })
			runModelId = input.config.modelId
			knownModels = (input.config.knownModels as Record<string, ModelInfo> | undefined) ?? knownModels
		}
		return baseFactory ? baseFactory(input) : input.createDefault()
	}
	const conversationModelId = () => runModelId ?? config.modelId

	config.extraTools = [
		...(config.extraTools ?? []),
		createAdvisorTool({
			getSettings: deps.getSettings,
			conversationModelId,
			// On a router the caller is whichever model the turn's last call landed on.
			callingModelId: () => {
				if (!deps.routerSessionKey || !isPlinyRouterModelId(conversationModelId())) {
					return undefined
				}
				const calls = getSessionState(deps.routerSessionKey).calls
				return calls[calls.length - 1]?.modelId
			},
			createModel: (modelId) => createModel?.(modelId),
			modelInfo: (modelId) => knownModels?.[modelId],
			checkBudget: deps.checkBudget,
			onUsage: deps.onUsage,
			ledger: deps.ledger,
			timeoutMs: deps.timeoutMs,
		}),
	]

	const baseBeforeModel = config.hooks?.beforeModel
	config.hooks = {
		...(config.hooks ?? {}),
		beforeModel: async (context) => {
			const baseResult = await baseBeforeModel?.(context)
			const tools = baseResult?.tools ?? context.request.tools
			const offered =
				!context.snapshot.parentAgentId &&
				advisorUnavailableReason(deps.getSettings(), conversationModelId()) === undefined
			if (baseResult?.stop || offered || !tools.some((tool) => tool.name === ADVISOR_TOOL_NAME)) {
				return baseResult
			}
			return { ...(baseResult ?? {}), tools: tools.filter((tool) => tool.name !== ADVISOR_TOOL_NAME) }
		},
	}

	return config
}
