/**
 * Wires the router (FreeAuto and BalanceAuto) into a session's `CoreSessionConfig`.
 *
 * This is the only file that knows about both the router and the extension
 * host: it owns the per-session state, turns routing events into the visible
 * timestamped chat rows, and decides whether a failed run should be recovered
 * with a different model.
 *
 * `installRouter` is called for every Pliny session, not only when a router
 * model is selected. The router is a passthrough for a concrete model, and
 * installing it unconditionally means a mid-task switch to FreeAuto or
 * BalanceAuto works — the session config is not rebuilt when only the model
 * changes.
 */

import type { CoreSessionConfig } from "@plinycode/core"
import {
	isPlinyBalanceAutoModelId,
	isPlinyFreeModelId,
	isPlinyRouterModelId,
	isPlinySelfHostedModelId,
	type ModelInfo,
	plinyRouterProfile,
	plinyRouterProfileSpec,
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
import { createReviewPass, type ReviewPassOptions } from "./router-review"
import { isSuccessfulEdit } from "./router-review-diff"
import { defaultRules } from "./router-rules"
import { loadRouterRules } from "./router-rules-store"
import { appendRunLog, type RouterRunEnding, type RouterRunLogRecord } from "./router-run-log"
import type { RouterCallShape, RouterCallTiming, RouterRequestFeatures, RouterRules } from "./router-types"
import { type ShellFailure, shellFailureFromResult } from "./unfinished-turn-guard"

export interface RouterInstallDeps {
	/** Key of the session's router state, and the call log's session id; `getSessionId` overrides it when set. */
	sessionId: string
	/** The session's id as it is when a run starts. */
	getSessionId?: () => string | undefined
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
	/** Whether the reviewer pass is on (`plinycode.review.beforeFinish`); on when not given. */
	reviewEnabled?: () => boolean
	/**
	 * What the current run changed, from the checkpoint taken when it started.
	 * Without it, or when there is no checkpoint, the reviewer pass falls back
	 * to the run's own edit calls.
	 */
	getRunChanges?: ReviewPassOptions["loadCheckpointDiff"]
	/** Injectable for tests. */
	now?: () => number
	/** Injectable for tests: the wait before retrying after a dropped connection. */
	sleep?: (ms: number) => Promise<void>
}

/** Wait before retrying a reply whose connection dropped: long enough for a gateway blip to pass. */
const TRANSPORT_RETRY_DELAY_MS = 2_000

/** The hidden prompt that resumes a reply a failed run left unfinished. */
function continuationPromptFor(error: string): string {
	if (isDegenerateOutputError(error)) {
		// The partial reply is garbage; continuing it would only produce more.
		return (
			"Your previous reply was corrupted (the same text repeated over and over) and has been " +
			"disregarded. Do not continue it. Redo the step from the last tool result: continue with the next " +
			"tool call, or give the final result if the task is complete."
		)
	}
	// Only the error's headline: the user-facing details and settings hints
	// would just add noise for the model.
	const headline = error.split(" (")[0].split(" — ")[0]
	const lostCall = toolCallCutOff(error)
	if (lostCall) {
		// The call never reached the history, so "continue where it stopped"
		// would invite the model to finish it as text.
		return (
			`Your previous reply was cut off (${headline}) while you were writing a \`${lostCall}\` tool call, ` +
			"so that call was lost and did not run. Make the call again now, through the tool-calling interface, " +
			"not as text. Do not repeat text you already produced."
		)
	}
	return (
		`Your previous reply was cut off (${headline}). Continue exactly where it stopped. ` +
		"Do not repeat text you already produced. If you were about to call a tool, make the call now through " +
		"the tool-calling interface, not as text."
	)
}

/** Model-facing note appended to a failed shell result, so weak models do not stop on it. */
function failedCommandNote(failure: ShellFailure): string {
	const what = failure.command ? `The command \`${failure.command.slice(0, 120)}\`` : "The command above"
	const how = failure.exitCode !== undefined ? ` failed with exit code ${failure.exitCode}` : " failed"
	return (
		`[${what}${how}. Do not end your turn now: fix the problem and rerun it. If the failure is expected, ` +
		"or you are blocked, say so explicitly and ask the user how to proceed.]"
	)
}

/** Model-facing note appended to a detached shell result. */
function detachedCommandNote(failure: ShellFailure): string {
	const where = failure.logPath ? ` Its output is being written to ${failure.logPath}.` : ""
	return (
		`[The command is still running in the background.${where} Do not end your turn to "check later" — you ` +
		"cannot come back. If the user is waiting for its result, call the `wait` tool, then read the log or run a " +
		"status command, and repeat until it finishes or you have a concrete blocker.]"
	)
}

/** `auto-free`, `auto-free-fast`, `auto-paid-balanced`, ... as shown in the chat rows. */
function routerLabel(profile: string): string {
	return plinyRouterProfileSpec(profile)?.label ?? (profile === "default" ? "auto-free" : `auto-free-${profile}`)
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

/** Catalog names of the models the router has seen, e.g. "Claude Sonnet 5", for chat rows. */
const modelNames = new Map<string, string>()

function rememberModelNames(knownModels: Record<string, ModelInfo> | undefined): void {
	for (const [id, info] of Object.entries(knownModels ?? {})) {
		const name = info?.name?.trim()
		if (name) {
			modelNames.set(id, name)
		}
	}
}

/** Model label for rows: its catalog name, or else the id without its pool prefix. */
function modelLabel(modelId: string): string {
	const name = modelNames.get(modelId)
	if (name) {
		return name
	}
	const slash = modelId.indexOf("/")
	return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

/**
 * The connection dropped mid-reply: the gateway or a proxy closed the
 * stream, or the network failed. Says nothing about the model, so it is
 * retried as is and never counts against the model's health.
 */
export function isTransportError(error: string): boolean {
	return /\b(terminated|other side closed|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|fetch failed|network error)\b/i.test(
		error,
	)
}

/** The tool call a reply was writing when it was cut off, as the llms stream reports it. */
function toolCallCutOff(error: string): string | undefined {
	return /cut off while writing an? (\S+) call/.exec(error)?.[1]
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
 * Install the router on a session config. Safe to call for any Pliny session;
 * the hooks no-op unless the session's model is a router id.
 */
export function installRouter(config: CoreSessionConfig, deps: RouterInstallDeps): CoreSessionConfig {
	const now = deps.now ?? (() => Date.now())
	const isRouted = () => isPlinyRouterModelId(config.modelId)
	const logCall = deps.logCall ?? ((record: RouterCallLogRecord) => void appendCallLog(record))
	const logRun = deps.logRun ?? ((record: RouterRunLogRecord) => void appendRunLog(record))
	const installProfile = plinyRouterProfile(config.modelId)

	/**
	 * Whether the completion guard and the shell-result notes apply to a turn.
	 * They exist for the free models, which stop early; the paid ones do not.
	 * A free model (FreeAuto or a concrete free pick) always qualifies. On
	 * BalanceAuto it depends on who is actually answering: the turn's last call
	 * must have run on a free model, and a nudge to a paid one would just cost
	 * a call.
	 */
	const freeModelIsAnswering = (turnKey: string): boolean => {
		if (isPlinyFreeModelId(config.modelId)) {
			return true
		}
		if (!isPlinyBalanceAutoModelId(config.modelId)) {
			return false
		}
		const calls = getSessionState(turnKey).calls
		const last = calls[calls.length - 1]
		return last !== undefined && isPlinySelfHostedModelId(last.modelId)
	}

	// Rules are loaded asynchronously but routing is synchronous, so keep the
	// last loaded copy per profile and refresh it in the background. The first
	// call of a session uses built-in defaults if the file has not been read
	// yet, which is the correct conservative behavior.
	const cachedRules = new Map<string, RouterRules>()
	const rulesFor = (profile: string) => cachedRules.get(profile) ?? defaultRules(profile)
	let onRulesLoaded: ((rules: RouterRules) => void) | undefined
	// The first load per profile is awaited by the routed model before its
	// first call, so the user's file, not the built-in defaults, routes it.
	// Bounded, so a slow disk can never hold a turn: past the bound the call
	// proceeds on whatever is cached and the load finishes in the background.
	const firstLoad = new Map<string, Promise<void>>()
	const FIRST_LOAD_WAIT_MS = 1_500
	const refreshRules = (profile: string) => {
		const load = loadRouterRules({ workspaceRoot: deps.workspaceRoot, profile })
			.then((rules) => {
				cachedRules.set(profile, rules)
				if (profile === installProfile) {
					onRulesLoaded?.(rules)
				}
			})
			.catch((error) => Logger.warn(`[FreeAuto] Failed to load ${profile} rules: ${error}`))
		if (!firstLoad.has(profile)) {
			firstLoad.set(profile, Promise.race([load, new Promise<void>((resolve) => setTimeout(resolve, FIRST_LOAD_WAIT_MS))]))
		}
	}
	const awaitRules = (profile: string) => firstLoad.get(profile) ?? Promise.resolve()
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
	// The key this session's router state lives under. Read per use: a config
	// is built before its session starts, and some callers give it another id
	// afterwards, so the id at install time may not be the session's.
	const sessionKey = () => deps.getSessionId?.()?.trim() || deps.sessionId
	let activeTurnKey = sessionKey()
	let activeProfile = installProfile
	// The judge needs a gateway model for the utility id; the factory is the
	// only place one can be built, so remember how from the latest run.
	let createUtilityModel: ((modelId: string) => AgentModel) | undefined
	// File edits of the current root turn, sub-agents' included, and the models
	// that made them: the reviewer pass must know a turn changed files even
	// when only a sub-agent did, and must not pick one of the authors.
	let turnEdits = { bySubAgents: 0, authors: new Set<string>() }
	// Set by onRunError when it asks for a retry, read by the factory for the
	// retry's run.
	let recoveringRootRun = false
	let transportRetriesThisTurn = 0
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	rememberModelNames(config.knownModels as Record<string, ModelInfo> | undefined)

	config.agentModelFactory = ({ config: agentConfig, createDefault }) => {
		createUtilityModel = (modelId) => createDefault({ modelId })
		if (!isPlinyRouterModelId(agentConfig.modelId)) {
			return createDefault()
		}
		const profile = plinyRouterProfile(agentConfig.modelId)
		const isSubAgent = Boolean(agentConfig.parentAgentId)
		const turnKey = isSubAgent ? `${sessionKey()}:sub:${++subRunCounter}` : sessionKey()
		// A run that recovers a failed one continues its turn: same call log,
		// failover budget, classifier verdict and edits for the reviewer.
		const continuesTurn = !isSubAgent && recoveringRootRun
		if (!isSubAgent) {
			recoveringRootRun = false
		}
		if (!isSubAgent && !continuesTurn) {
			forgetSessionsWithPrefix(`${sessionKey()}:sub:`)
			turnEdits = { bySubAgents: 0, authors: new Set() }
			transportRetriesThisTurn = 0
		}
		activeTurnKey = turnKey
		activeProfile = profile
		rememberModelNames(agentConfig.knownModels as Record<string, ModelInfo> | undefined)
		const rowPrefix = isSubAgent ? "↳ sub-agent " : ""
		// Every other run is a new turn from the router's point of view.
		if (!continuesTurn) {
			beginTurn(turnKey, now())
		}
		refreshRules(profile)

		const logAttempt = (
			modelId: string,
			timing: RouterCallTiming,
			outcome: RouterCallLogRecord["outcome"],
			error?: string,
			shape?: RouterCallShape,
		) => {
			const state = getSessionState(turnKey)
			const call = [...state.calls].reverse().find((entry) => entry.modelId === modelId)
			const firstCall = call !== undefined && call === state.calls[0]
			logCall({
				ts: new Date(timing.startedAt).toISOString(),
				sessionId: sessionKey(),
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
				...(shape
					? {
							...(shape.finishReason !== undefined ? { finishReason: shape.finishReason } : {}),
							textChars: shape.textChars,
							reasoningChars: shape.reasoningChars,
							toolCalls: shape.toolCalls,
						}
					: {}),
			})
		}

		return createRoutedAgentModel({
			now,
			label: routerLabel(profile),
			rules: () => rulesFor(profile),
			awaitRules: () => awaitRules(profile),
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
				onCallSuccess: ({ modelId, timing, shape }) => {
					recordSuccess(modelId)
					logAttempt(modelId, timing, "success", undefined, shape)
				},
				onCallError: ({ modelId, error, timing, shape }) => {
					const state = getSessionState(turnKey)
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					logAttempt(modelId, timing, "error", error, shape)
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
			emitInfo(
				`\`${formatClock(now())}\` ⚠ ${routerLabel(activeProfile)} stopped retrying after ${state.failovers} failovers this turn.`,
			)
			return false
		}

		const failedModelId = state.calls[state.calls.length - 1]?.modelId
		const toolFailure = isToolFailure(error)
		// A dropped connection says nothing about the model: the first one in a
		// turn is retried on the same model after a short wait, and none counts
		// against its health. A second one in the same turn moves on.
		const transportRetry = isTransportError(error) && transportRetriesThisTurn < 1
		if (transportRetry) {
			transportRetriesThisTurn += 1
		} else if (failedModelId && !toolFailure) {
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
		const failedLabel = modelLabel(failedModelId ?? "unknown")
		const attempts = `attempt ${attempt}/${rules.health.maxFailoversPerTurn}`
		emitInfo(
			transportRetry
				? `\`${formatClock(now())}\` ⚠ The connection to **${failedLabel}** dropped: _${error}_ · retrying (${attempts})`
				: `\`${formatClock(now())}\` ⚠ Turn failed on **${failedLabel}**: _${error}_ · retrying with another model (${attempts})`,
		)
		Logger.warn(`[FreeAuto] run recovery attempt ${attempt}${transportRetry ? " (transport)" : ""}: ${error}`)
		if (transportRetry) {
			await sleep(TRANSPORT_RETRY_DELAY_MS)
		}
		// The retry continues this turn: the factory must not start a new one.
		recoveringRootRun = true

		return {
			retry: true,
			...(hadAssistantContent ? { continuationPrompt: continuationPromptFor(error) } : {}),
		}
	}

	// Free models often stop before the task is done: they announce a step
	// ("Let me check the log:") without the tool call, promise to check back
	// later, or report a failed command as if it were the result. The guard
	// keeps such runs going. Core applies it to the root agent only (sub-agents
	// get no completion policy), so both its state and the BalanceAuto "is a
	// free model answering?" check are the root turn's — never a sub-agent's.
	const rootState = () => getSessionState(sessionKey())
	const MAX_NUDGES = 8
	const stallGuard = createRouterCompletionGuard({
		isActive: () => freeModelIsAnswering(sessionKey()),
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
			} else if (rule === "text-tool-call" && !escalated) {
				emitInfo(
					`${clock} ↻ The model wrote a tool call as text, so nothing ran · asked it to make the call (${nudgesThisRun}/${MAX_NUDGES})`,
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
		onGiveUp: ({ rule, excerpt, reason }) => {
			rootState().run.guardGaveUp = reason
			const why =
				reason === "repeated-stall"
					? "it stalled three times in a row"
					: reason === "unanswered-budget"
						? "it ignored too many reminders this turn"
						: `all ${MAX_NUDGES} reminders for this turn are used up`
			emitInfo(
				`\`${formatClock(now())}\` ⏹ The model stopped again after _"${excerpt}"_ · not asking again: ${why}. ` +
					"The task may be unfinished; send a message to continue.",
			)
			Logger.warn(`[FreeAuto] completion guard gave up (${rule}, ${reason}): ${excerpt}`)
		},
		onEscalate: () => {
			// A model that ignores a reminder, or keeps stalling between steps, gets swapped for the default
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

	// Once the guard accepts the reply that would end the run, a second free
	// model reads what the run changed. It is asked after the guard, and outside
	// it, so its one reminder neither spends the guard's reminder budgets nor is
	// held back by them.
	const reviewPass = createReviewPass({
		isActive: isRouted,
		isEnabled: () => deps.reviewEnabled?.() ?? true,
		getMode: deps.getMode,
		// A paid model's fix-up round is billed, which BalanceAuto users signed up for and FreeAuto users did not.
		fixRoundAllowed: () => isPlinyBalanceAutoModelId(config.modelId) || freeModelIsAnswering(sessionKey()),
		guardGaveUp: () => rootState().run.guardGaveUp !== undefined,
		recorded: () => rootState().run.review,
		record: (review) => {
			rootState().run.review = review
		},
		rules: () => rulesFor(activeProfile),
		knownModels: () => config.knownModels as Record<string, ModelInfo> | undefined,
		isHealthy: (modelId) => isModelHealthy(modelId, now()),
		authors: () =>
			new Set([
				...rootState()
					.calls.filter((call) => !call.failure)
					.map((call) => call.modelId),
				...turnEdits.authors,
			]),
		subAgentEdits: () => turnEdits.bySubAgents,
		createModel: (modelId) => createUtilityModel?.(modelId),
		...(deps.getRunChanges ? { loadCheckpointDiff: deps.getRunChanges } : {}),
		...(deps.workspaceRoot ? { cwd: deps.workspaceRoot } : {}),
		now,
		onStart: ({ modelId, files, added, removed }) => {
			emitInfo(
				`\`${formatClock(now())}\` 🔎 **${modelLabel(modelId)}** is reviewing this turn's changes ` +
					`(${files} file${files === 1 ? "" : "s"}, +${added} −${removed})`,
			)
		},
		onResult: ({ modelId, record, issues, raw }) => {
			const clock = `\`${formatClock(now())}\``
			const took = formatDuration(record.durationMs ?? 0)
			if (record.outcome === "no-verdict") {
				emitInfo(
					`${clock} 🔎 The review by **${modelLabel(modelId)}** gave no result (_${record.reason}_) · finishing without it`,
				)
				Logger.warn(
					`[FreeAuto] review (${modelId}) gave no verdict after ${record.durationMs}ms: ${record.reason}` +
						(raw ? ` · raw reply: ${JSON.stringify(raw)}` : ""),
				)
				return
			}
			emitInfo(
				issues.length > 0
					? `${clock} 🔎 **${modelLabel(modelId)}** flagged ${issues.length} possible problem${issues.length === 1 ? "" : "s"} ` +
							`(${took}) · asked the model to check ${issues.length === 1 ? "it" : "them"}`
					: `${clock} 🔎 **${modelLabel(modelId)}** found no problems (${took})`,
			)
			Logger.log(
				`[FreeAuto] review (${modelId}, ${record.durationMs}ms, ${record.source}, ${record.files} files): ` +
					`${issues.length} issues${issues.map((issue) => ` · ${issue.file ?? "?"}: ${issue.problem}`).join("")}`,
			)
		},
		onReviewerError: (modelId, error) => {
			// A reviewer that cannot be reached is down for routing too.
			const rules = rulesFor(activeProfile)
			recordFailure(modelId, {
				error,
				failuresBeforeCooldown: rules.health.failuresBeforeCooldown,
				cooldownMs: rules.health.cooldownMs,
				now: now(),
			})
		},
	})
	config.completionGuard = async (context) => (await stallGuard(context)) ?? (await reviewPass(context))

	// Observe tool results and run endings: the shell-result note stops weak
	// models from ending on a failed command, and the run record is what the
	// summary script reads to compare early-stop rates per model.
	config.hooks = composeHooks(config.hooks, {
		afterTool: ({ snapshot, tool, toolCall, result }) => {
			if (isRouted() && isSuccessfulEdit(tool.name, result)) {
				const calls = getSessionState(snapshot.parentAgentId ? activeTurnKey : sessionKey()).calls
				const author = calls[calls.length - 1]?.modelId
				if (author) {
					turnEdits.authors.add(author)
				}
				if (snapshot.parentAgentId) {
					turnEdits.bySubAgents += 1
				}
			}
			// Hooks run in sub-agents too; judge by the agent that ran the tool.
			if (!freeModelIsAnswering(snapshot.parentAgentId ? activeTurnKey : sessionKey())) {
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
			const state = getSessionState(subAgent ? activeTurnKey : sessionKey())
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
				sessionId: sessionKey(),
				subAgent,
				profile: activeProfile,
				...(lastCall ? { model: lastCall.modelId, route: lastCall.routeName } : {}),
				calls: state.calls.length,
				iterations: result.iterations,
				ending,
				...run,
				// Core consults the completion guard, and so the reviewer, for the root agent only.
				...(subAgent ? { review: { outcome: "skipped" as const, reason: "sub-agent" } } : {}),
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
	if (!isPlinyRouterModelId(modelId)) {
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

	const label = routerLabel(plinyRouterProfile(modelId))
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
