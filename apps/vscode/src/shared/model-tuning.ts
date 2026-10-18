import type { ModelInfo, ThinkingControls } from "./api"
import { isPlinyRouterModelId } from "./pliny"

/**
 * Per-model tuning the user sets from the chat box: reasoning on or off, the
 * effort level, and a smaller context budget. Stored once per model id
 * (`modelTuning` in global state) and applied to every conversation on that
 * model. Router models only take the context budget: their routes choose the
 * reasoning per call.
 */

export const MODEL_TUNING_EFFORTS = ["low", "medium", "high"] as const
export type ModelTuningEffort = (typeof MODEL_TUNING_EFFORTS)[number]

export interface ModelTuning {
	/** Reasoning forced on (true) or off (false); unset keeps the model's default. */
	thinking?: boolean
	/** Effort level sent when reasoning is on. */
	effort?: ModelTuningEffort
	/** Prompt budget in tokens: compaction starts below it. Only ever lowers the model's own. */
	maxInputTokens?: number
}

export type ModelTuningMap = Record<string, ModelTuning>

/** Context budgets offered in the picker, largest first. */
const MODEL_TUNING_CONTEXT_PRESETS = [128_000, 64_000, 32_000] as const

/** Below this a coding agent cannot hold a system prompt, tools and a file or two. */
const MIN_TUNED_INPUT_TOKENS = 16_000

/** What the picker may offer for one model. */
interface ModelTuningOptions {
	/** Reasoning can be switched off (it is on by default and a switch was measured). */
	canTurnOff: boolean
	/** Reasoning can be switched on (it is off by default and `reasoning_effort` turns it on). */
	canTurnOn: boolean
	/** An effort level changes something (`reasoning_effort` is the model's on-switch). */
	effort: boolean
	/** Context budgets below the model's own, largest first. */
	contextPresets: number[]
}

/** The model's own prompt budget: its maxInputTokens, else its context window. */
function baseInputTokens(info: Pick<ModelInfo, "contextWindow" | "maxInputTokens"> | undefined): number | undefined {
	const maxInput = info?.maxInputTokens
	if (maxInput && maxInput > 0) {
		return maxInput
	}
	const window = info?.contextWindow
	return window && window > 0 ? window : undefined
}

export function modelTuningOptions(
	info: Pick<ModelInfo, "contextWindow" | "maxInputTokens" | "thinkingControls"> | undefined,
	isRouter: boolean,
): ModelTuningOptions {
	const controls: ThinkingControls | undefined = isRouter ? undefined : info?.thinkingControls
	const base = baseInputTokens(info)
	return {
		canTurnOff: !!controls?.defaultOn && !!controls.off,
		canTurnOn: !!controls && !controls.defaultOn && controls.on === "reasoning-effort",
		effort: controls?.on === "reasoning-effort",
		contextPresets: MODEL_TUNING_CONTEXT_PRESETS.filter((preset) => base === undefined || preset < base),
	}
}

function isEffort(value: unknown): value is ModelTuningEffort {
	return typeof value === "string" && (MODEL_TUNING_EFFORTS as readonly string[]).includes(value)
}

/** A stored entry with every invalid field dropped; undefined when nothing is left. */
export function normalizeModelTuning(value: unknown): ModelTuning | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined
	}
	const raw = value as Record<string, unknown>
	const tuning: ModelTuning = {}
	if (typeof raw.thinking === "boolean") {
		tuning.thinking = raw.thinking
	}
	if (isEffort(raw.effort) && tuning.thinking !== false) {
		tuning.effort = raw.effort
	}
	const maxInput = raw.maxInputTokens
	if (typeof maxInput === "number" && Number.isFinite(maxInput) && maxInput >= MIN_TUNED_INPUT_TOKENS) {
		tuning.maxInputTokens = Math.floor(maxInput)
	}
	return Object.keys(tuning).length > 0 ? tuning : undefined
}

export function modelTuningFor(map: ModelTuningMap | undefined, modelId: string | undefined): ModelTuning | undefined {
	if (!map || !modelId) {
		return undefined
	}
	return normalizeModelTuning(map[modelId])
}

/** The prompt budget after tuning: the lower of the model's own and the tuned one. */
export function tunedInputTokens(base: number | undefined, tuning: ModelTuning | undefined): number | undefined {
	const tuned = tuning?.maxInputTokens
	if (!tuned) {
		return base
	}
	return base === undefined ? tuned : Math.min(base, tuned)
}

/**
 * The session reasoning a tuning asks for, or undefined when it asks for
 * nothing. "Off" and an effort level are both explicit, so they win over the
 * provider-wide reasoning setting.
 */
export function tunedReasoning(
	tuning: ModelTuning | undefined,
): { thinking: boolean; reasoningEffort?: ModelTuningEffort } | undefined {
	if (!tuning) {
		return undefined
	}
	if (tuning.thinking === false) {
		return { thinking: false }
	}
	if (tuning.effort) {
		return { thinking: true, reasoningEffort: tuning.effort }
	}
	// "On" without a level: the on-switch is reasoning_effort, so it needs one.
	return tuning.thinking === true ? { thinking: true, reasoningEffort: "medium" } : undefined
}

/**
 * The session reasoning a model's tuning asks for. A router's routes choose
 * the reasoning per call, so a tuning never sets it there.
 */
export function sessionReasoningFor(modelId: string, tuning: ModelTuning | undefined): ReturnType<typeof tunedReasoning> {
	return isPlinyRouterModelId(modelId) ? undefined : tunedReasoning(tuning)
}

/**
 * The known models with the session model's prompt budget lowered to its
 * tuned one, which is what compaction budgets against. Entries are copied,
 * never changed in place.
 */
export function applyTunedInputBudget<T extends { contextWindow?: number; maxInputTokens?: number }>(
	knownModels: Record<string, T> | undefined,
	modelId: string,
	tuning: ModelTuning | undefined,
): Record<string, T> | undefined {
	const info = knownModels?.[modelId]
	if (!knownModels || !info || !tuning?.maxInputTokens) {
		return knownModels
	}
	const maxInputTokens = tunedInputTokens(baseInputTokens(info), tuning)
	return maxInputTokens === undefined ? knownModels : { ...knownModels, [modelId]: { ...info, maxInputTokens } }
}

/** A short label for the tuning, e.g. "thinking off, 64k context"; empty when untuned. */
export function describeModelTuning(tuning: ModelTuning | undefined): string {
	if (!tuning) {
		return ""
	}
	const parts: string[] = []
	if (tuning.thinking === false) {
		parts.push("thinking off")
	} else if (tuning.effort) {
		parts.push(`effort ${tuning.effort}`)
	} else if (tuning.thinking === true) {
		parts.push("thinking on")
	}
	if (tuning.maxInputTokens) {
		parts.push(`${Math.round(tuning.maxInputTokens / 1000)}k context`)
	}
	return parts.join(", ")
}
