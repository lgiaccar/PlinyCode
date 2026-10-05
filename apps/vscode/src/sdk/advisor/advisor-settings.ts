/**
 * Settings of the advisor tool (`ask_advisor`, see advisor-tool.ts) as plain
 * values, and the rule that decides whether a conversation is offered it.
 * The VS Code reader is `hosts/vscode/advisor-settings.ts`.
 */

import { canonicalPlinyModelId, isPlinyBalanceAutoModelId, isPlinyRouterModelId } from "@shared/pliny"

export const ADVISOR_TOOL_NAME = "ask_advisor"

const ADVISOR_USE_VALUES = ["balance", "always", "never"] as const

/**
 * `balance`: only conversations running on BalanceAuto, where paid calls are
 * already expected. `always`: any conversation, including FreeAuto and the
 * free models, which then spends money. `never`: off.
 */
type AdvisorUse = (typeof ADVISOR_USE_VALUES)[number]

export interface AdvisorSettings {
	use: AdvisorUse
	/** Concrete Pliny model id the advice comes from. */
	model: string
	maxCallsPerConversation: number
}

/** Claude Sonnet 5: the lead of BalanceAuto's `default` route (router-rules.ts). */
const DEFAULT_ADVISOR_MODEL_ID = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"

export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = {
	use: "balance",
	model: DEFAULT_ADVISOR_MODEL_ID,
	maxCallsPerConversation: 5,
}

const MAX_CALLS_CEILING = 50

/** Anything unusable falls back to the default, so a typo never widens what is spent. */
export function normalizeAdvisorSettings(raw: {
	use?: unknown
	model?: unknown
	maxCallsPerConversation?: unknown
}): AdvisorSettings {
	const use = (ADVISOR_USE_VALUES as readonly unknown[]).includes(raw.use)
		? (raw.use as AdvisorUse)
		: DEFAULT_ADVISOR_SETTINGS.use
	const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULT_ADVISOR_SETTINGS.model
	const maxCalls = raw.maxCallsPerConversation
	const maxCallsPerConversation =
		typeof maxCalls === "number" && Number.isFinite(maxCalls) && maxCalls >= 0
			? Math.min(Math.floor(maxCalls), MAX_CALLS_CEILING)
			: DEFAULT_ADVISOR_SETTINGS.maxCallsPerConversation
	return { use, model, maxCallsPerConversation }
}

/**
 * Why a conversation running on `conversationModelId` is not offered the
 * advisor; undefined when it is. The text is model-facing: it is also the
 * error a call gets when the setting or the model changed mid-conversation.
 */
export function advisorUnavailableReason(settings: AdvisorSettings, conversationModelId: string | undefined): string | undefined {
	if (settings.use === "never") {
		return "The advisor is turned off (plinycode.advisor.use)."
	}
	if (isPlinyRouterModelId(settings.model)) {
		return "plinycode.advisor.model must name a concrete model, not a router."
	}
	if (conversationModelId && canonicalPlinyModelId(conversationModelId) === settings.model) {
		return "This conversation already runs on the advisor model."
	}
	if (settings.use === "balance" && !isPlinyBalanceAutoModelId(conversationModelId)) {
		return "The advisor is only available in conversations that run on auto-paid-balanced (plinycode.advisor.use)."
	}
	return undefined
}
