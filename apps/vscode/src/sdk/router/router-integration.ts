/**
 * Wires FreeAuto into a session's `CoreSessionConfig`.
 *
 * This is the only file that knows about both the router and the extension
 * host: it owns the per-session state, turns routing events into the visible
 * timestamped chat rows, and decides whether a failed run should be recovered
 * with a different model.
 *
 * `installRouter` is called for every Pliny session, not only when FreeAuto is
 * selected. The router is a passthrough for a concrete model, and installing it
 * unconditionally means a mid-task switch to FreeAuto works — the session config
 * is not rebuilt when only the model changes.
 */

import type { CoreSessionConfig } from "@plinycode/core"
import { isPlinyFreeAutoModelId, type ModelInfo } from "@plinycode/llms"
import { type AgentModelRequest, estimateRequestInputTokens } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { createRoutedAgentModel } from "./routed-agent-model"
import { beginTurn, getSessionState, isModelHealthy, recordFailure, recordSuccess } from "./router-health"
import { defaultRules } from "./router-rules"
import { loadRouterRules } from "./router-rules-store"
import type { RouterRequestFeatures, RouterRules } from "./router-types"

export interface RouterInstallDeps {
	sessionId: string
	/** Workspace root, so a project-local rules file is picked up. */
	workspaceRoot?: string
	/** Current plan/act mode at call time. */
	getMode: () => "plan" | "act"
	/** Emits a chat row. Rows are persisted and replayed with history. */
	emitRow: (message: ClineMessage) => void
	/** Mints a unique, monotonic message id. */
	nextMessageTs: () => number
	/** Injectable for tests. */
	now?: () => number
}

/** `HH:MM:SS` for in-turn rows; the date leads the first row of a turn. */
function formatClock(ms: number): string {
	const date = new Date(ms)
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `YYYY-MM-DD HH:MM:SS`, used for the first row of a turn and the summary. */
function formatStamp(ms: number): string {
	const date = new Date(ms)
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(ms)}`
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) {
		return `${seconds}s`
	}
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** Short model label for rows: the id without its pool prefix. */
function modelLabel(modelId: string): string {
	const slash = modelId.indexOf("/")
	return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

function approxTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

/** Latest user text in the request, used for keyword routing. */
function latestUserPrompt(request: AgentModelRequest): string {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index]
		if (message?.role !== "user") {
			continue
		}
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim()
		if (text) {
			return text
		}
	}
	return ""
}

function requestHasImages(request: AgentModelRequest): boolean {
	return request.messages.some((message) => message.content.some((part) => part.type === "image"))
}

/**
 * Install FreeAuto on a session config. Safe to call for any Pliny session;
 * the hooks no-op unless the session's model is the router.
 */
export function installRouter(config: CoreSessionConfig, deps: RouterInstallDeps): CoreSessionConfig {
	const now = deps.now ?? (() => Date.now())
	const isRouted = () => isPlinyFreeAutoModelId(config.modelId)

	// Rules are loaded asynchronously but routing is synchronous, so keep the
	// last loaded copy and refresh it in the background. The first call of a
	// session uses built-in defaults if the file has not been read yet, which is
	// the correct conservative behavior.
	let cachedRules: RouterRules | undefined
	const refreshRules = () => {
		loadRouterRules({ workspaceRoot: deps.workspaceRoot })
			.then((rules) => {
				cachedRules = rules
			})
			.catch((error) => Logger.warn(`[FreeAuto] Failed to load rules: ${error}`))
	}
	refreshRules()

	const emitInfo = (text: string) => {
		deps.emitRow({
			ts: deps.nextMessageTs(),
			type: "say",
			say: "info",
			text,
			partial: false,
		})
	}

	config.agentModelFactory = ({ config: agentConfig, createDefault }) => {
		if (!isPlinyFreeAutoModelId(agentConfig.modelId)) {
			return createDefault()
		}
		// Each run is a new turn from the router's point of view.
		beginTurn(deps.sessionId, now())
		refreshRules()

		return createRoutedAgentModel({
			now,
			rules: () => cachedRules ?? fallbackRules(),
			knownModels: () => agentConfig.knownModels as Record<string, ModelInfo> | undefined,
			isHealthy: (modelId) => isModelHealthy(modelId, now()),
			createDelegate: (modelId) => createDefault({ modelId }),
			features: (request) => buildFeatures(request, deps, now()),
			observer: {
				onCallStart: ({ modelId, decision, features }) => {
					const state = getSessionState(deps.sessionId)
					const startedAt = now()
					state.calls.push({ modelId, startedAt, routeName: decision.routeName })
					if (cachedRules?.sticky !== false) {
						state.stickyModelId = modelId
					}
					const stamp = state.calls.length === 1 ? formatStamp(startedAt) : formatClock(startedAt)
					emitInfo(
						`\`${stamp}\` FreeAuto → **${modelLabel(modelId)}** ` +
							`(call ${state.calls.length} · route: ${decision.routeName} · ~${approxTokens(features.estimatedTokens)} tok)`,
					)
					Logger.log(
						`[FreeAuto] call ${state.calls.length} → ${modelId} (route=${decision.routeName}, est=${features.estimatedTokens})`,
					)
				},
				onFailover: ({ modelId, nextModelId, error }) => {
					const rules = cachedRules ?? fallbackRules()
					const state = getSessionState(deps.sessionId)
					state.failovers += 1
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					const { benched } = recordFailure(modelId, {
						error,
						failuresBeforeCooldown: rules.health.failuresBeforeCooldown,
						cooldownMs: rules.health.cooldownMs,
						now: now(),
					})
					if (state.stickyModelId === modelId) {
						state.stickyModelId = nextModelId
					}
					emitInfo(
						`\`${formatClock(now())}\` ⚠ **${modelLabel(modelId)}** failed: _${error}_` +
							(benched ? " · benched" : "") +
							(nextModelId ? ` → continuing with **${modelLabel(nextModelId)}**` : " · no candidates left"),
					)
					Logger.warn(`[FreeAuto] failover ${modelId} → ${nextModelId ?? "(none)"}: ${error}`)
				},
				onCallSuccess: ({ modelId }) => {
					recordSuccess(modelId)
				},
				onCallError: ({ modelId, error }) => {
					const state = getSessionState(deps.sessionId)
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					Logger.warn(`[FreeAuto] ${modelId} failed after producing output: ${error}`)
				},
			},
		})
	}

	config.onRunError = async ({ error, errorClass, attempt, hadAssistantContent }) => {
		if (!isRouted()) {
			return false
		}
		const rules = cachedRules ?? fallbackRules()
		const state = getSessionState(deps.sessionId)

		if (errorClass === "auth") {
			return false
		}
		if (state.failovers >= rules.health.maxFailoversPerTurn) {
			emitInfo(`\`${formatClock(now())}\` ⚠ FreeAuto stopped retrying after ${state.failovers} failovers this turn.`)
			return false
		}

		const failedModelId = state.calls[state.calls.length - 1]?.modelId
		const toolFailure = isToolFailure(error)
		if (failedModelId && !toolFailure) {
			// A tool that aborted is not the model's fault, so it must not count
			// against the model's health — but it is still worth another attempt.
			recordFailure(failedModelId, {
				error,
				failuresBeforeCooldown: rules.health.failuresBeforeCooldown,
				cooldownMs: rules.health.cooldownMs,
				now: now(),
			})
			if (state.stickyModelId === failedModelId) {
				state.stickyModelId = undefined
			}
		}

		state.failovers += 1
		emitInfo(
			`\`${formatClock(now())}\` ⚠ Turn failed on **${modelLabel(failedModelId ?? "unknown")}**: _${error}_ · ` +
				`retrying with another model (attempt ${attempt}/${rules.health.maxFailoversPerTurn})`,
		)
		Logger.warn(`[FreeAuto] run recovery attempt ${attempt}: ${error}`)

		return {
			retry: true,
			...(hadAssistantContent
				? {
						continuationPrompt:
							`Your previous reply was cut off (${error}). Continue exactly where it stopped. ` +
							`Do not repeat text you already produced. If you were in the middle of a tool call, re-issue it.`,
					}
				: {}),
		}
	}

	// Compaction summaries talk to the gateway directly, so they must never be
	// handed the virtual router id.
	if (isRouted()) {
		const rules = cachedRules ?? fallbackRules()
		const summarizerModelId = rules.utility.summarizer
		config.compaction = {
			...(config.compaction ?? {}),
			enabled: config.compaction?.enabled ?? true,
			summarizer: {
				providerId: config.providerId,
				modelId: summarizerModelId,
				apiKey: config.apiKey,
				baseUrl: config.baseUrl,
				knownModels: config.knownModels,
				...(config.providerConfig ? { providerConfig: { ...config.providerConfig, modelId: summarizerModelId } } : {}),
			},
		}
	}

	return config
}

/**
 * Emit the end-of-turn summary. Called when a turn settles, whether it
 * succeeded or failed.
 */
export function emitTurnSummary(deps: RouterInstallDeps, modelId: string): void {
	if (!isPlinyFreeAutoModelId(modelId)) {
		return
	}
	const now = deps.now ?? (() => Date.now())
	const state = getSessionState(deps.sessionId)
	if (state.calls.length === 0) {
		return
	}

	const counts = new Map<string, number>()
	for (const call of state.calls) {
		counts.set(call.modelId, (counts.get(call.modelId) ?? 0) + 1)
	}
	const breakdown = [...counts.entries()]
		.map(([id, count]) => (count > 1 ? `${modelLabel(id)}×${count}` : modelLabel(id)))
		.join(", ")
	const elapsed = formatDuration(now() - state.turnStartedAt)
	const failovers = state.failovers > 0 ? ` · ${state.failovers} failover${state.failovers === 1 ? "" : "s"}` : ""

	deps.emitRow({
		ts: deps.nextMessageTs(),
		type: "say",
		say: "info",
		text:
			`\`${formatStamp(now())}\` turn ended (${elapsed}) — ` +
			`${state.calls.length} call${state.calls.length === 1 ? "" : "s"}: ${breakdown}${failovers}`,
		partial: false,
	})
	Logger.log(`[FreeAuto] turn ended: ${state.calls.length} calls (${breakdown})${failovers}`)
}

/**
 * Tool failures ("Command execution aborted") surface as run errors but say
 * nothing about the model, so they must not bench it.
 */
function isToolFailure(error: string): boolean {
	const normalized = error.toLowerCase()
	return normalized.includes("command execution aborted") || normalized.includes("command failed")
}

/**
 * Built-in defaults, used only for the first call of a session before the rules
 * file has been read.
 */
function fallbackRules(): RouterRules {
	return defaultRules()
}

function buildFeatures(request: AgentModelRequest, deps: RouterInstallDeps, _now: number): RouterRequestFeatures {
	const state = getSessionState(deps.sessionId)
	return {
		estimatedTokens: estimateRequestInputTokens({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		}),
		mode: deps.getMode(),
		prompt: latestUserPrompt(request),
		hasImages: requestHasImages(request),
		callIndex: state.calls.length + 1,
		...(state.stickyModelId ? { stickyModelId: state.stickyModelId } : {}),
	}
}
