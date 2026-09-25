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
import {
	isPlinyFreeAutoModelId,
	isPlinyFreeModelId,
	type ModelInfo,
	plinyFreeAutoProfile,
	plinyThinkingControls,
} from "@plinycode/llms"
import { type AgentModel, type AgentModelRequest, estimateRequestInputTokens } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { createRouterCompletionGuard } from "./completion-guard"
import { createRoutedAgentModel, isDegenerateOutputError } from "./routed-agent-model"
import { appendCallLog, type RouterCallLogRecord } from "./router-call-log"
import { runClassifier } from "./router-classifier"
import { runCompletionJudge } from "./router-completion-judge"
import {
	beginTurn,
	forgetSessionsWithPrefix,
	getSessionState,
	isModelHealthy,
	recordFailure,
	recordSuccess,
} from "./router-health"
import { composeHooks } from "./router-hooks"
import { defaultRules } from "./router-rules"
import { loadRouterRules } from "./router-rules-store"
import { appendRunLog, type RouterRunEnding, type RouterRunLogRecord } from "./router-run-log"
import type { RouterCallTiming, RouterRequestFeatures, RouterRules } from "./router-types"
import { type ShellFailure, shellFailureFromResult } from "./unfinished-turn-guard"

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
	/** Where the call log goes; defaults to the call log next to the rules files. */
	logCall?: (record: RouterCallLogRecord) => void
	/** Where the run log goes; defaults to the run log next to the rules files. */
	logRun?: (record: RouterRunLogRecord) => void
	/** Injectable for tests. */
	now?: () => number
}

/** Model-facing note appended to a failed shell result, so weak models do not stop on it. */
export function failedCommandNote(failure: ShellFailure): string {
	const what = failure.command ? `The command \`${failure.command.slice(0, 120)}\`` : "The command above"
	const how = failure.exitCode !== undefined ? ` failed with exit code ${failure.exitCode}` : " failed"
	return (
		`[${what}${how}. Do not end your turn now: fix the problem and rerun it. If the failure is expected, ` +
		"or you are blocked, say so explicitly and ask the user how to proceed.]"
	)
}

/** Model-facing note appended to a detached shell result. */
export function detachedCommandNote(failure: ShellFailure): string {
	const where = failure.logPath ? ` Its output is being written to ${failure.logPath}.` : ""
	return (
		`[The command is still running in the background.${where} Do not end your turn to "check later" — you ` +
		"cannot come back. If the user is waiting for its result, call the `wait` tool, then read the log or run a " +
		"status command, and repeat until it finishes or you have a concrete blocker.]"
	)
}

/** `FreeAuto`, or `FreeAuto·fast` for a non-default profile. */
function routerLabel(profile: string): string {
	return profile === "default" ? "FreeAuto" : `FreeAuto·${profile}`
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
	// The guard and the shell-result notes help every free model, routed or not.
	const guardActive = () => isPlinyFreeModelId(config.modelId)
	const logCall = deps.logCall ?? ((record: RouterCallLogRecord) => void appendCallLog(record))
	const logRun = deps.logRun ?? ((record: RouterRunLogRecord) => void appendRunLog(record))
	const installProfile = plinyFreeAutoProfile(config.modelId)

	// Rules are loaded asynchronously but routing is synchronous, so keep the
	// last loaded copy per profile and refresh it in the background. The first
	// call of a session uses built-in defaults if the file has not been read
	// yet, which is the correct conservative behavior.
	const cachedRules = new Map<string, RouterRules>()
	const rulesFor = (profile: string) => cachedRules.get(profile) ?? defaultRules(profile)
	let onRulesLoaded: ((rules: RouterRules) => void) | undefined
	const refreshRules = (profile: string) => {
		loadRouterRules({ workspaceRoot: deps.workspaceRoot, profile })
			.then((rules) => {
				cachedRules.set(profile, rules)
				if (profile === installProfile) {
					onRulesLoaded?.(rules)
				}
			})
			.catch((error) => Logger.warn(`[FreeAuto] Failed to load ${profile} rules: ${error}`))
	}
	if (isRouted()) {
		refreshRules(installProfile)
	}

	const emitInfo = (text: string) => {
		deps.emitRow({
			ts: deps.nextMessageTs(),
			type: "say",
			say: "info",
			text,
			partial: false,
		})
	}

	// Core copies this factory into every spawned sub-agent, whose runs happen
	// inside the parent's turn. Each such run gets its own turn key so it cannot
	// reset the parent's call log, sticky model or failover budget; model health
	// stays process-wide. `activeTurnKey` is what `onRunError` (also copied to
	// sub-agents, without access to the run) consults; sub-agent runs are
	// sequential within the parent's tool call, so the latest key is the right
	// one. Parallel spawn_agent calls would share it — a known limitation.
	let subRunCounter = 0
	let activeTurnKey = deps.sessionId
	let activeProfile = installProfile
	// The judge needs a gateway model for the utility id; the factory is the
	// only place one can be built, so remember how from the latest run.
	let createUtilityModel: ((modelId: string) => AgentModel) | undefined

	config.agentModelFactory = ({ config: agentConfig, createDefault }) => {
		createUtilityModel = (modelId) => createDefault({ modelId })
		if (!isPlinyFreeAutoModelId(agentConfig.modelId)) {
			return createDefault()
		}
		const profile = plinyFreeAutoProfile(agentConfig.modelId)
		const isSubAgent = Boolean(agentConfig.parentAgentId)
		const turnKey = isSubAgent ? `${deps.sessionId}:sub:${++subRunCounter}` : deps.sessionId
		if (!isSubAgent) {
			forgetSessionsWithPrefix(`${deps.sessionId}:sub:`)
		}
		activeTurnKey = turnKey
		activeProfile = profile
		const rowPrefix = isSubAgent ? "↳ sub-agent " : ""
		// Each run is a new turn from the router's point of view.
		beginTurn(turnKey, now())
		refreshRules(profile)

		const logAttempt = (
			modelId: string,
			timing: RouterCallTiming,
			outcome: RouterCallLogRecord["outcome"],
			error?: string,
		) => {
			const state = getSessionState(turnKey)
			const call = [...state.calls].reverse().find((entry) => entry.modelId === modelId)
			const firstCall = call !== undefined && call === state.calls[0]
			logCall({
				ts: new Date(timing.startedAt).toISOString(),
				sessionId: deps.sessionId,
				subAgent: isSubAgent,
				profile,
				route: call?.routeName ?? "default",
				...(call?.classification ? { tier: call.classification.tier, think: call.classification.think } : {}),
				...(firstCall && state.classifierError ? { classifierError: state.classifierError.slice(0, 200) } : {}),
				...(call?.effort ? { effort: call.effort } : {}),
				model: modelId,
				...(call?.estimatedTokens !== undefined ? { estimatedTokens: call.estimatedTokens } : {}),
				...(timing.firstContentAt !== undefined ? { ttftMs: timing.firstContentAt - timing.startedAt } : {}),
				durationMs: timing.endedAt - timing.startedAt,
				outcome,
				...(error ? { error: error.slice(0, 300) } : {}),
			})
		}

		return createRoutedAgentModel({
			now,
			rules: () => rulesFor(profile),
			knownModels: () => agentConfig.knownModels as Record<string, ModelInfo> | undefined,
			isHealthy: (modelId) => isModelHealthy(modelId, now()),
			createDelegate: (modelId) => createDefault({ modelId }),
			features: (request) => buildFeatures(request, { turnKey, isSubAgent, mode: deps.getMode() }),
			thinkingControls: plinyThinkingControls,
			classify: async (request, features, rules) => {
				if (!rules.classifier.enabled || features.isSubAgent) {
					return undefined
				}
				const state = getSessionState(turnKey)
				if (state.classifierRan) {
					return state.classification
				}
				state.classifierRan = true
				const startedAt = now()
				const result = await runClassifier({
					model: createDefault({ modelId: rules.utility.classifier }),
					request,
					features,
					rules,
				})
				const elapsed = now() - startedAt
				if (result.classification) {
					state.classification = result.classification
					Logger.log(
						`[FreeAuto] classifier (${rules.utility.classifier}, ${elapsed}ms): ` +
							`tier=${result.classification.tier} think=${result.classification.think}`,
					)
				} else {
					state.classifierError = result.error ?? "no verdict"
					emitInfo(
						`\`${formatClock(now())}\` ${routerLabel(profile)} classifier gave no verdict (${result.error}) · using the heuristic routes`,
					)
					Logger.warn(
						`[FreeAuto] classifier (${rules.utility.classifier}) gave no verdict after ${elapsed}ms: ${result.error}` +
							(result.raw ? ` · raw reply: ${JSON.stringify(result.raw)}` : ""),
					)
				}
				return state.classification
			},
			observer: {
				onCallStart: ({ modelId, decision, features, effort }) => {
					const state = getSessionState(turnKey)
					const startedAt = now()
					state.calls.push({
						modelId,
						startedAt,
						routeName: decision.routeName,
						estimatedTokens: features.estimatedTokens,
						...(effort ? { effort } : {}),
						...(decision.classification ? { classification: decision.classification } : {}),
					})
					if (rulesFor(profile).sticky) {
						state.stickyModelId = modelId
					}
					const stamp = state.calls.length === 1 ? formatStamp(startedAt) : formatClock(startedAt)
					const classifierTag =
						decision.classification && state.calls.length === 1
							? ` · classifier: ${decision.classification.tier}${decision.classification.think ? "+think" : ""}`
							: ""
					emitInfo(
						`\`${stamp}\` ${rowPrefix}${routerLabel(profile)} → **${modelLabel(modelId)}** ` +
							`(call ${state.calls.length} · route: ${decision.routeName}${effort ? ` · ${effort}` : ""}${classifierTag} · ` +
							`~${approxTokens(features.estimatedTokens)} tok)`,
					)
					Logger.log(
						`[FreeAuto] ${isSubAgent ? "sub-agent " : ""}call ${state.calls.length} → ${modelId} ` +
							`(profile=${profile}, route=${decision.routeName}, effort=${effort ?? "default"}, est=${features.estimatedTokens})`,
					)
				},
				onFailover: ({ modelId, nextModelId, error, timing }) => {
					const rules = rulesFor(profile)
					const state = getSessionState(turnKey)
					state.failovers += 1
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					logAttempt(modelId, timing, "failover", error)
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
						`\`${formatClock(now())}\` ${rowPrefix}⚠ **${modelLabel(modelId)}** failed: _${error}_` +
							(benched ? " · benched" : "") +
							(nextModelId ? ` → continuing with **${modelLabel(nextModelId)}**` : " · no candidates left"),
					)
					Logger.warn(`[FreeAuto] failover ${modelId} → ${nextModelId ?? "(none)"}: ${error}`)
				},
				onCallSuccess: ({ modelId, timing }) => {
					recordSuccess(modelId)
					logAttempt(modelId, timing, "success")
				},
				onCallError: ({ modelId, error, timing }) => {
					const state = getSessionState(turnKey)
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					logAttempt(modelId, timing, "error", error)
					Logger.warn(`[FreeAuto] ${modelId} failed after producing output: ${error}`)
				},
			},
		})
	}

	config.onRunError = async ({ error, errorClass, attempt, hadAssistantContent }) => {
		if (!isRouted()) {
			return false
		}
		const rules = rulesFor(activeProfile)
		const state = getSessionState(activeTurnKey)

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
						continuationPrompt: isDegenerateOutputError(error)
							? // The partial reply is garbage; continuing it would only produce more.
								"Your previous reply was corrupted (the same characters repeated over and over) and has been " +
								"disregarded. Do not continue it. Redo the step from the last tool result: continue with the next " +
								"tool call, or give the final result if the task is complete."
							: // Only the error's headline: the user-facing details and
								// settings hints would just add noise for the model.
								`Your previous reply was cut off (${error.split(" (")[0]}). Continue exactly where it stopped. ` +
								`Do not repeat text you already produced. If you were in the middle of a tool call, re-issue it.`,
					}
				: {}),
		}
	}

	// Free models often stop before the task is done: they announce a step
	// ("Let me check the log:") without the tool call, promise to check back
	// later, or report a failed command as if it were the result. The guard
	// keeps such runs going; core applies it to the root agent only, so its
	// state is the root turn's.
	const rootState = () => getSessionState(deps.sessionId)
	const MAX_NUDGES = 3
	config.completionGuard = createRouterCompletionGuard({
		isActive: guardActive,
		getMode: deps.getMode,
		toolCallsThisRun: () => rootState().run.toolCalls,
		maxNudgesPerRun: MAX_NUDGES,
		judge: async (context) => {
			const rules = rulesFor(activeProfile)
			if (!rules.guard.judge || !createUtilityModel) {
				return undefined
			}
			const startedAt = now()
			const result = await runCompletionJudge({
				model: createUtilityModel(rules.utility.judge),
				context,
				timeoutMs: rules.guard.judgeTimeoutMs,
			})
			const elapsed = now() - startedAt
			if (!result.verdict) {
				Logger.warn(
					`[FreeAuto] judge (${rules.utility.judge}) gave no verdict after ${elapsed}ms: ${result.error}` +
						(result.raw ? ` · raw reply: ${JSON.stringify(result.raw)}` : ""),
				)
				return undefined
			}
			Logger.log(
				`[FreeAuto] judge (${rules.utility.judge}, ${elapsed}ms): done=${result.verdict.done}${result.verdict.reason ? ` — ${result.verdict.reason}` : ""}`,
			)
			return result.verdict
		},
		onJudge: (outcome) => {
			rootState().run.judge = outcome
		},
		onNudge: ({ rule, excerpt, nudgesThisRun, escalated, reason }) => {
			const run = rootState().run
			run.nudges = nudgesThisRun
			run.guardRules.push(rule)
			if (escalated) {
				run.escalated = true
			}
			const clock = `\`${formatClock(now())}\``
			if (rule === "judge") {
				emitInfo(
					`${clock} ⚖ The task looks unfinished${reason ? ` — _${reason}_` : ""} · asked the model to continue (${nudgesThisRun}/${MAX_NUDGES})`,
				)
			} else if (escalated) {
				emitInfo(
					`${clock} ↻ The model stalled again after _"${excerpt}"_ · sent a firmer reminder (${nudgesThisRun}/${MAX_NUDGES})`,
				)
			} else {
				emitInfo(
					`${clock} ↻ The model stopped after _"${excerpt}"_ without acting · asked it to continue (rule: ${rule}, ${nudgesThisRun}/${MAX_NUDGES})`,
				)
			}
			Logger.log(`[FreeAuto] completion guard fired (${rule}${escalated ? ", escalated" : ""}): ${excerpt}`)
		},
		onEscalate: () => {
			// A model that ignores a reminder gets swapped for the default
			// route's lead — the one that keeps acting on long tasks.
			if (!isRouted()) {
				return
			}
			const state = rootState()
			const current = state.calls[state.calls.length - 1]?.modelId
			const rules = rulesFor(activeProfile)
			const preferred = rules.routes.find((route) => route.name === "default")?.use ?? []
			const next = [...preferred, ...rules.pool].find((id) => id !== current && rules.pool.includes(id))
			if (next && rules.sticky) {
				state.stickyModelId = next
				emitInfo(`\`${formatClock(now())}\` ↪ switching to **${modelLabel(next)}** for the rest of the turn`)
				Logger.log(`[FreeAuto] escalation: sticky model ${current ?? "(none)"} → ${next}`)
			}
		},
	})

	// Observe tool results and run endings: the shell-result note stops weak
	// models from ending on a failed command, and the run record is what the
	// summary script reads to compare early-stop rates per model.
	config.hooks = composeHooks(config.hooks, {
		afterTool: ({ snapshot, tool, toolCall, result }) => {
			if (!guardActive()) {
				return undefined
			}
			const failure = shellFailureFromResult({
				type: "tool-result",
				toolCallId: toolCall.toolCallId,
				toolName: tool.name,
				output: result.output,
				...(result.isError ? { isError: true } : {}),
			})
			// Only the root agent's tools feed the completion guard's state.
			if (!snapshot.parentAgentId) {
				const run = rootState().run
				run.toolCalls += 1
				run.previousTool = tool.name
				run.previousToolFailed = failure?.kind === "failed"
				run.previousToolDetached = failure?.kind === "detached"
			}
			if (!failure) {
				return undefined
			}
			return { appendContext: failure.kind === "failed" ? failedCommandNote(failure) : detachedCommandNote(failure) }
		},
		afterRun: ({ snapshot, result }) => {
			if (!isRouted()) {
				return
			}
			const subAgent = Boolean(snapshot.parentAgentId)
			const state = getSessionState(subAgent ? activeTurnKey : deps.sessionId)
			const lastCall = state.calls[state.calls.length - 1]
			const lastAssistant = [...result.messages].reverse().find((message) => message.role === "assistant")
			const reply = lastAssistant
				? lastAssistant.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("")
				: ""
			const ending: RouterRunEnding =
				result.status === "aborted"
					? "aborted"
					: result.status === "failed"
						? "error"
						: lastAssistant?.content.some((part) => part.type === "tool-call")
							? "completion-tool"
							: "text"
			const { guardRules, ...run } = state.run
			logRun({
				ts: new Date(now()).toISOString(),
				sessionId: deps.sessionId,
				subAgent,
				profile: activeProfile,
				...(lastCall ? { model: lastCall.modelId, route: lastCall.routeName } : {}),
				calls: state.calls.length,
				iterations: result.iterations,
				ending,
				...run,
				guardRules: [...guardRules],
				replyChars: reply.length,
				replyTail: reply.trim().slice(-120),
				durationMs: now() - state.turnStartedAt,
			})
		},
	})

	// Compaction summaries talk to the gateway directly, so they must never be
	// handed the virtual router id. The rules file has not loaded yet at this
	// point, so the summarizer starts on the built-in default and is updated in
	// place once the file is read: core keeps a reference to this object rather
	// than a copy.
	if (isRouted()) {
		const summarizerModelId = defaultRules(installProfile).utility.summarizer
		const summarizer = {
			providerId: config.providerId,
			modelId: summarizerModelId,
			apiKey: config.apiKey,
			baseUrl: config.baseUrl,
			knownModels: config.knownModels,
			...(config.providerConfig ? { providerConfig: { ...config.providerConfig, modelId: summarizerModelId } } : {}),
		}
		config.compaction = {
			...(config.compaction ?? {}),
			enabled: config.compaction?.enabled ?? true,
			summarizer,
		}
		onRulesLoaded = (rules) => {
			summarizer.modelId = rules.utility.summarizer
			if (summarizer.providerConfig) {
				summarizer.providerConfig.modelId = rules.utility.summarizer
			}
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

	const label = routerLabel(plinyFreeAutoProfile(modelId))
	deps.emitRow({
		ts: deps.nextMessageTs(),
		type: "say",
		say: "info",
		text:
			`\`${formatStamp(now())}\` ${label} turn ended (${elapsed}) — ` +
			`${state.calls.length} call${state.calls.length === 1 ? "" : "s"}: ${breakdown}${failovers}`,
		partial: false,
	})
	Logger.log(`[FreeAuto] ${label} turn ended: ${state.calls.length} calls (${breakdown})${failovers}`)
}

/**
 * Tool failures ("Command execution aborted") surface as run errors but say
 * nothing about the model, so they must not bench it.
 */
function isToolFailure(error: string): boolean {
	const normalized = error.toLowerCase()
	return normalized.includes("command execution aborted") || normalized.includes("command failed")
}

function buildFeatures(
	request: AgentModelRequest,
	run: { turnKey: string; isSubAgent: boolean; mode: "plan" | "act" },
): RouterRequestFeatures {
	const state = getSessionState(run.turnKey)
	return {
		estimatedTokens: estimateRequestInputTokens({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		}),
		mode: run.mode,
		prompt: latestUserPrompt(request),
		hasImages: requestHasImages(request),
		isSubAgent: run.isSubAgent,
		callIndex: state.calls.length + 1,
		...(state.stickyModelId ? { stickyModelId: state.stickyModelId } : {}),
	}
}
