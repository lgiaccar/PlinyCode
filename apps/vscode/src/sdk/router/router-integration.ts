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
	plinyRouterProfileAllowsPaid,
	plinyRouterProfileSpec,
	plinyThinkingControls,
} from "@plinycode/llms"
import { type AgentModel, type AgentModelRequest, estimateRequestInputTokens } from "@plinycode/shared"
import type { ClineMessage, ClineSubagentUsageInfo } from "@shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import type { ModelCallUsage } from "../one-shot-model-call"
import { createRouterCompletionGuard } from "./completion-guard"
import { createRoutedAgentModel, isDegenerateOutputError } from "./routed-agent-model"
import { addUsageTotals, appendCallLog, type RouterCallLogRecord, type RouterCallLogUsage } from "./router-call-log"
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
import {
	beginImageTurn,
	createRouterImageHandler,
	type RouterImageMode,
	type RouterImageNotice,
	requestHasImages,
} from "./router-images"
import { createReviewPass, type ReviewPassOptions } from "./router-review"
import { isSuccessfulEdit } from "./router-review-diff"
import { defaultRules } from "./router-rules"
import { loadRouterRules } from "./router-rules-store"
import { appendRunLog, type RouterRunEnding, type RouterRunLogRecord } from "./router-run-log"
import type {
	RouterCallRecord,
	RouterCallShape,
	RouterCallTiming,
	RouterCallUsage,
	RouterClassification,
	RouterEffort,
	RouterMode,
	RouterRequestFeatures,
	RouterRules,
} from "./router-types"
import { isExpectedQueryExit, latestUserRequest, type ShellFailure, shellFailureFromResult } from "./unfinished-turn-guard"

/**
 * What the router did on one call attempt, reported to the session trace
 * (`sdk/trace/session-trace.ts`). The router's own JSONL logs are separate
 * and unchanged by this.
 */
export interface RouterCallEvent {
	/** start: a candidate is about to be called; failover: it failed before output and the next one takes over; success/error: how the call ended. */
	kind: "start" | "failover" | "success" | "error"
	profile: string
	subAgent: boolean
	modelId: string
	/** start: the route that matched, its candidates in order, and the classifier's verdict when it ran. */
	route?: string
	candidates?: string[]
	effort?: RouterEffort
	classification?: RouterClassification
	estimatedTokens?: number
	callIndex?: number
	/** failover/error: what went wrong; failover: the model that takes over and whether the failed one was benched. */
	error?: string
	nextModelId?: string
	benched?: boolean
	/** failover/success/error: the attempt's timing and, once it produced output, the reply's shape. */
	durationMs?: number
	ttftMs?: number
	finishReason?: string
	textChars?: number
	reasoningChars?: number
	toolCalls?: number
}

export interface RouterInstallDeps {
	/** Key of the session's router state, and the call log's session id; `getSessionId` overrides it when set. */
	sessionId: string
	/** The session's id as it is when a run starts. */
	getSessionId?: () => string | undefined
	/** Workspace root, so a project-local rules file is picked up. */
	workspaceRoot?: string
	/** Current routing mode (plan, act or ask) at call time. */
	getMode: () => RouterMode
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
	/** Receives each call attempt's routing decision and outcome, for the session trace. */
	onCallEvent?: (event: RouterCallEvent) => void
	/** How routed calls with images are handled (`router-images.ts`); see {@link RouterImageDeps}. */
	images?: RouterImageDeps
	/** Injectable for tests. */
	now?: () => number
	/** Injectable for tests: the wait before retrying after a dropped connection. */
	sleep?: (ms: number) => Promise<void>
}

/**
 * What the host tells the router about images. Every field is optional: with
 * none, images are described when a free model can do it and otherwise
 * replaced by a note, so nothing is spent.
 */
export interface RouterImageDeps {
	/** `plinycode.router.images`, read per call; `describe` when not given. */
	mode?: () => RouterImageMode
	/** Whether "Unlock Pliny paid models" is on. A BalanceAuto conversation may use paid models either way. */
	paidModelsUnlocked?: () => boolean
	/** The conversation budget, checked before paid image work; see `AdvisorToolDeps.checkBudget`. */
	checkBudget?: (sessionId: string) => Promise<string | undefined>
	/** Told what each image description cost, after the call (a background task records it here). */
	onUsage?: (sessionId: string, usage: ModelCallUsage) => void
	/** Injectable for tests: the time limit of one description call. */
	timeoutMs?: number
}

/** Wait before retrying a reply whose connection dropped: long enough for a gateway blip to pass. */
const TRANSPORT_RETRY_DELAY_MS = 2_000

/**
 * Failed commands in one turn (a failed build, a failing test run) after which
 * the rest of the turn moves to the default route's lead. Edit, build and test
 * cycles that fail every time are the signal, so the count is not reset by a
 * command that passes in between.
 */
const FAILED_COMMANDS_BEFORE_ESCALATION = 6

/** The timing and shape fields of a finished attempt's trace event. */
function callEventOutcome(timing: RouterCallTiming, shape: RouterCallShape): Partial<RouterCallEvent> {
	return {
		durationMs: timing.endedAt - timing.startedAt,
		...(timing.firstContentAt !== undefined ? { ttftMs: timing.firstContentAt - timing.startedAt } : {}),
		...(shape.finishReason !== undefined ? { finishReason: shape.finishReason } : {}),
		textChars: shape.textChars,
		reasoningChars: shape.reasoningChars,
		toolCalls: shape.toolCalls,
	}
}

/** The call log's token counts for a call's usage. */
function logUsage(usage: RouterCallUsage): RouterCallLogUsage {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
		...(usage.estimated ? { estimated: true } : {}),
	}
}

/**
 * What a call cost in USD. A free self-hosted model costs nothing whether or
 * not it reported usage; a paid one costs what its usage events said, and is
 * unknown when they said nothing.
 */
function callCostUsd(modelId: string, usage: RouterCallUsage | undefined): number | undefined {
	return isPlinySelfHostedModelId(modelId) ? 0 : usage?.costUsd
}

/** Tokens, cost and models of a set of calls, for the run log. */
interface CallTotals {
	usage?: RouterCallLogUsage
	costUsd?: number
	models: Record<string, number>
	paidCalls: number
	paidCostUsd?: number
}

function callTotals(calls: readonly RouterCallRecord[]): CallTotals {
	const totals: CallTotals = { models: {}, paidCalls: 0 }
	for (const call of calls) {
		totals.models[call.modelId] = (totals.models[call.modelId] ?? 0) + 1
		const paid = !isPlinySelfHostedModelId(call.modelId)
		if (paid) {
			totals.paidCalls += 1
		}
		if (call.usage) {
			totals.usage = addUsageTotals(totals.usage, logUsage(call.usage))
		}
		const cost = callCostUsd(call.modelId, call.usage)
		if (cost !== undefined) {
			totals.costUsd = (totals.costUsd ?? 0) + cost
			if (paid) {
				totals.paidCostUsd = (totals.paidCostUsd ?? 0) + cost
			}
		}
	}
	return totals
}

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

/**
 * Shell-result notes per run: the first two failed or detached commands get
 * one, the rest do not. Each note is a user message that stays in the
 * transcript, and a run that fails commands in a row (an audit found 159 of
 * them across 25 sessions) was reading a wall of "fix the problem and rerun
 * it" instead of the results.
 */
const SHELL_NOTES_PER_RUN = 2

/** Model-facing note appended to a failed shell result, so weak models do not stop on it. */
function failedCommandNote(failure: ShellFailure): string {
	const what = failure.command ? `The command \`${failure.command.slice(0, 120)}\`` : "The command above"
	const how = failure.exitCode !== undefined ? ` exited with code ${failure.exitCode}` : " failed"
	return `[${what}${how}. If that is expected, go on; otherwise fix it before you finish.]`
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

/**
 * The latest thing the user typed, used for keyword routing and handed to the
 * classifier as the request. Runtime reminders, hook context and compaction
 * summaries are skipped, and the `<editor_state>` and `<mode_notice>` blocks
 * are stripped: an open tab named `app.ts` used to match the coding regex,
 * and the open-tabs list pushed every prompt past the quick route's length.
 */
function latestUserPrompt(request: AgentModelRequest): string {
	return latestUserRequest(request.messages)
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
	 * A free model (FreeAuto or a concrete free pick) qualifies unless FreeAuto
	 * put the turn's last call on an image-capable paid model
	 * (`plinycode.router.images: vision-model`). On BalanceAuto it depends on
	 * who is actually answering: the turn's last call must have run on a free
	 * model, and a nudge to a paid one would just cost a call.
	 */
	const freeModelIsAnswering = (turnKey: string): boolean => {
		const calls = getSessionState(turnKey).calls
		const last = calls[calls.length - 1]
		if (isPlinyFreeModelId(config.modelId)) {
			return !isRouted() || last === undefined || isPlinySelfHostedModelId(last.modelId)
		}
		if (!isPlinyBalanceAutoModelId(config.modelId)) {
			return false
		}
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

	// An image description is a call the engine never sees: its cost reaches
	// the task header, the budget check and the history record through a
	// hidden usage row, like an advisor call's (task-usage-metadata.ts).
	const emitVisionUsage = (usage: ModelCallUsage) => {
		const payload: ClineSubagentUsageInfo = {
			source: "vision",
			tokensIn: usage.inputTokens,
			tokensOut: usage.outputTokens,
			cacheWrites: usage.cacheWriteTokens,
			cacheReads: usage.cacheReadTokens,
			cost: usage.totalCost,
			...(usage.estimated ? { estimated: true } : {}),
		}
		deps.emitRow({
			ts: deps.nextMessageTs(),
			type: "say",
			say: "subagent_usage",
			text: JSON.stringify(payload),
			partial: false,
		})
	}

	const emitImageNotice = (notice: RouterImageNotice, rowPrefix: string) => {
		const clock = `\`${formatClock(now())}\` ${rowPrefix}`
		switch (notice.kind) {
			case "described":
				emitInfo(
					`${clock}🖼 Images were described by **${modelLabel(notice.modelId)}** because the free models can't see images ` +
						`(${notice.count} image${notice.count === 1 ? "" : "s"}${notice.cost > 0 ? `, $${notice.cost.toFixed(4)}` : ""}; ` +
						"each image is described once per conversation · plinycode.router.images)",
				)
				return
			case "vision-model":
				emitInfo(
					`${clock}🖼 This turn has a new image, so it runs on **${modelLabel(notice.modelId)}**, which can see it ` +
						"(plinycode.router.images: vision-model)",
				)
				return
			case "off":
				emitInfo(
					`${clock}🖼 Images are not shown to the free models (plinycode.router.images: off): the model was told an image was attached.`,
				)
				return
			case "paid-locked":
				emitInfo(
					`${clock}⚠ The image was not shown to the model: the free models can't see images, and ` +
						`${notice.mode === "describe" ? "describing it" : "routing the turn to a model that can"} needs a paid model, ` +
						"which is locked. Turn on **Unlock Pliny paid models** (Settings → API configuration) to have images " +
						"described for under a cent each, or switch to an image-capable model.",
				)
				return
			case "budget":
				emitInfo(
					`${clock}⚠ The image was not shown to the model: ${notice.reason} The model was told an image was attached.`,
				)
				return
			case "failed":
				emitInfo(
					`${clock}⚠ **${modelLabel(notice.modelId)}** could not describe an image (_${notice.error}_) · the model was told it was not shown`,
				)
				return
		}
	}

	// Core copies this factory into every spawned sub-agent, whose runs happen
	// inside the parent's turn. Each such run gets its own turn key so it cannot
	// reset the parent's call log, sticky model or failover budget; model health
	// stays process-wide. Runs are told apart by the engine's agent id, which
	// the factory, `onRunError` and the hooks' snapshots all carry: parallel
	// spawn_agent calls each find their own state, and a root failure after a
	// sub-agent run benches the root's model, not the sub-agent's.
	let subRunCounter = 0
	// The key this session's router state lives under. Read per use: a config
	// is built before its session starts, and some callers give it another id
	// afterwards, so the id at install time may not be the session's.
	const sessionKey = () => deps.getSessionId?.()?.trim() || deps.sessionId
	const runsByAgent = new Map<string, { turnKey: string; profile: string }>()
	// For a hook or error that names no agent: the newest sub-agent key, the
	// way things worked when sub-agent runs could only be sequential.
	let latestSubRunKey: string | undefined
	let activeProfile = installProfile
	const turnKeyFor = (agentId: string | undefined, parentAgentId: string | null | undefined): string => {
		const run = agentId ? runsByAgent.get(agentId) : undefined
		if (run) {
			return run.turnKey
		}
		return parentAgentId ? (latestSubRunKey ?? sessionKey()) : sessionKey()
	}
	// The judge needs a gateway model for the utility id; the factory is the
	// only place one can be built, so remember how from the latest run.
	let createUtilityModel: ((modelId: string) => AgentModel) | undefined
	// File edits of the current root turn, sub-agents' included, and the models
	// that made them: the reviewer pass must know a turn changed files even
	// when only a sub-agent did, and must not pick one of the authors.
	let turnEdits = { bySubAgents: 0, authors: new Set<string>() }
	// Set by onRunError when it asks for a retry, read by the factory for the
	// retry's run: the agent ids whose next run continues their turn. The
	// root's flag is kept apart for an engine that names no agent.
	const recoveringRuns = new Set<string>()
	let recoveringRootRun = false
	let transportRetriesThisTurn = 0
	// Where each agent's run is (engine run id and iteration), from the
	// beforeModel hook, so call log lines can be matched with the session trace.
	const runPositions = new Map<string, { runId?: string; iteration: number }>()
	let rootPosition: { runId?: string; iteration: number } | undefined
	// Shell-result notes sent so far in each agent's current run (SHELL_NOTES_PER_RUN).
	const shellNotes = new Map<string, { runId?: string; count: number }>()
	// What the current root turn's sub-agent runs spent, for the root run's log line.
	let turnSubAgents: { calls: number; usage?: RouterCallLogUsage; costUsd?: number } = { calls: 0 }
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	rememberModelNames(config.knownModels as Record<string, ModelInfo> | undefined)

	config.agentModelFactory = ({ config: agentConfig, createDefault, agentId }) => {
		createUtilityModel = (modelId) => createDefault({ modelId })
		if (!isPlinyRouterModelId(agentConfig.modelId)) {
			return createDefault()
		}
		const profile = plinyRouterProfile(agentConfig.modelId)
		const isSubAgent = Boolean(agentConfig.parentAgentId)
		// A run that recovers a failed one continues its turn: same call log,
		// failover budget, classifier verdict and edits for the reviewer.
		const recovering = agentId ? recoveringRuns.delete(agentId) : false
		const continuesTurn = recovering || (!isSubAgent && recoveringRootRun)
		if (!isSubAgent) {
			recoveringRootRun = false
		}
		const turnKey = continuesTurn
			? turnKeyFor(agentId, agentConfig.parentAgentId)
			: isSubAgent
				? `${sessionKey()}:sub:${++subRunCounter}`
				: sessionKey()
		if (!isSubAgent && !continuesTurn) {
			forgetSessionsWithPrefix(`${sessionKey()}:sub:`)
			for (const [id, run] of runsByAgent) {
				if (run.turnKey !== sessionKey()) {
					runsByAgent.delete(id)
				}
			}
			latestSubRunKey = undefined
			turnEdits = { bySubAgents: 0, authors: new Set() }
			turnSubAgents = { calls: 0 }
			transportRetriesThisTurn = 0
		}
		if (agentId) {
			runsByAgent.set(agentId, { turnKey, profile })
		}
		if (isSubAgent) {
			latestSubRunKey = turnKey
		}
		activeProfile = profile
		rememberModelNames(agentConfig.knownModels as Record<string, ModelInfo> | undefined)
		const rowPrefix = isSubAgent ? "↳ sub-agent " : ""
		// Every other run is a new turn from the router's point of view.
		if (!continuesTurn) {
			beginTurn(turnKey, now())
			if (!isSubAgent) {
				beginImageTurn(sessionKey())
			}
		}
		refreshRules(profile)
		const imageHandler = createRouterImageHandler({
			conversationKey: sessionKey,
			mode: () => deps.images?.mode?.() ?? "describe",
			// BalanceAuto's users opted into paid calls; FreeAuto's only by unlocking paid models.
			paidAllowed: () => isPlinyBalanceAutoModelId(agentConfig.modelId) || deps.images?.paidModelsUnlocked?.() === true,
			knownModels: () => agentConfig.knownModels as Record<string, ModelInfo> | undefined,
			createModel: (modelId) => createDefault({ modelId }),
			checkBudget: () => deps.images?.checkBudget?.(sessionKey()) ?? Promise.resolve(undefined),
			onUsage: ({ modelId, sha, usage }) => {
				emitVisionUsage(usage)
				deps.images?.onUsage?.(sessionKey(), usage)
				Logger.log(
					`[FreeAuto] ${modelId} described image ${sha}: $${usage.totalCost.toFixed(4)}${usage.estimated ? " (estimated)" : ""}`,
				)
			},
			onNotice: (notice) => emitImageNotice(notice, rowPrefix),
			...(deps.images?.timeoutMs !== undefined ? { timeoutMs: deps.images.timeoutMs } : {}),
		})

		/**
		 * The first healthy free model of the coding route, then the pool, other
		 * than `exclude`: where a turn goes when it has spent its paid-call budget.
		 */
		const firstFreeModel = (rules: RouterRules, exclude: string | undefined): string | undefined => {
			const coding = rules.routes.find((route) => route.name === "coding")?.use ?? []
			return [...coding, ...rules.pool].find(
				(id) => id !== exclude && rules.pool.includes(id) && isPlinySelfHostedModelId(id) && isModelHealthy(id, now()),
			)
		}

		/**
		 * `health.maxPaidCallsPerTurn`: a turn that starts on paid Claude keeps it
		 * (sticky) for every call, and a turn can run to a hundred calls when the
		 * model is polling a build. Past the cap the rest of the turn runs on a
		 * free model, once per turn; a later failover back to a paid backup is
		 * left alone, and the run log says the cap fired.
		 */
		const applyPaidCap = (): void => {
			const rules = rulesFor(profile)
			const cap = rules.health.maxPaidCallsPerTurn
			if (!plinyRouterProfileAllowsPaid(profile) || cap <= 0 || !rules.sticky) {
				return
			}
			const state = getSessionState(turnKey)
			if (state.run.paidCapHit) {
				return
			}
			const paid = state.calls.filter((call) => !isPlinySelfHostedModelId(call.modelId)).length
			if (paid < cap) {
				return
			}
			const next = firstFreeModel(rules, state.stickyModelId)
			if (!next) {
				return
			}
			state.run.paidCapHit = true
			state.stickyModelId = next
			emitInfo(
				`\`${formatClock(now())}\` ${rowPrefix}⚠ ${paid} paid calls this turn (health.maxPaidCallsPerTurn: ${cap}) · ` +
					`↪ switching to **${modelLabel(next)}** for the rest of the turn`,
			)
			Logger.log(`[FreeAuto] paid-call cap: ${paid} paid calls this turn, sticky model → ${next}`)
		}

		const logAttempt = (
			modelId: string,
			timing: RouterCallTiming,
			outcome: RouterCallLogRecord["outcome"],
			error?: string,
			shape?: RouterCallShape,
			usage?: RouterCallUsage,
		) => {
			const state = getSessionState(turnKey)
			const call = [...state.calls].reverse().find((entry) => entry.modelId === modelId)
			const firstCall = call !== undefined && call === state.calls[0]
			if (call && usage) {
				call.usage = usage
			}
			const costUsd = callCostUsd(modelId, usage)
			if (isSubAgent) {
				turnSubAgents.calls += 1
				if (usage) {
					turnSubAgents.usage = addUsageTotals(turnSubAgents.usage, logUsage(usage))
				}
				if (costUsd !== undefined) {
					turnSubAgents.costUsd = (turnSubAgents.costUsd ?? 0) + costUsd
				}
			}
			const position = (agentId ? runPositions.get(agentId) : undefined) ?? (isSubAgent ? undefined : rootPosition)
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
				...(usage ? { usage: logUsage(usage) } : {}),
				...(costUsd !== undefined ? { costUsd } : {}),
				...(position?.runId ? { runId: position.runId } : {}),
				...(position ? { iteration: position.iteration } : {}),
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
			features: (request) => {
				applyPaidCap()
				return buildFeatures(request, { turnKey, isSubAgent, mode: deps.getMode() })
			},
			thinkingControls: plinyThinkingControls,
			planImages: (request) => imageHandler.plan(request),
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
					deps.onCallEvent?.({
						kind: "start",
						profile,
						subAgent: isSubAgent,
						modelId,
						route: decision.routeName,
						candidates: decision.candidates,
						...(effort ? { effort } : {}),
						...(decision.classification ? { classification: decision.classification } : {}),
						estimatedTokens: features.estimatedTokens,
						callIndex: state.calls.length,
					})
				},
				onFailover: ({ modelId, nextModelId, error, timing, usage }) => {
					const rules = rulesFor(profile)
					const state = getSessionState(turnKey)
					state.failovers += 1
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					logAttempt(modelId, timing, "failover", error, undefined, usage)
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
					deps.onCallEvent?.({
						kind: "failover",
						profile,
						subAgent: isSubAgent,
						modelId,
						error,
						...(nextModelId ? { nextModelId } : {}),
						benched,
						durationMs: timing.endedAt - timing.startedAt,
					})
				},
				onCallSuccess: ({ modelId, timing, shape, usage }) => {
					recordSuccess(modelId)
					logAttempt(modelId, timing, "success", undefined, shape, usage)
					deps.onCallEvent?.({
						kind: "success",
						profile,
						subAgent: isSubAgent,
						modelId,
						...callEventOutcome(timing, shape),
					})
				},
				onCallError: ({ modelId, error, timing, shape, usage }) => {
					const state = getSessionState(turnKey)
					const last = state.calls[state.calls.length - 1]
					if (last && last.modelId === modelId) {
						last.failure = error
					}
					logAttempt(modelId, timing, "error", error, shape, usage)
					deps.onCallEvent?.({
						kind: "error",
						profile,
						subAgent: isSubAgent,
						modelId,
						error,
						...callEventOutcome(timing, shape),
					})
					Logger.warn(`[FreeAuto] ${modelId} failed after producing output: ${error}`)
				},
			},
		})
	}

	config.onRunError = async ({ error, errorClass, attempt, hadAssistantContent, agentId, parentAgentId }) => {
		if (!isRouted()) {
			return false
		}
		const run = agentId ? runsByAgent.get(agentId) : undefined
		const profile = run?.profile ?? activeProfile
		const rules = rulesFor(profile)
		const state = getSessionState(turnKeyFor(agentId, parentAgentId))

		if (errorClass === "auth") {
			return false
		}
		if (state.failovers >= rules.health.maxFailoversPerTurn) {
			emitInfo(
				`\`${formatClock(now())}\` ⚠ ${routerLabel(profile)} stopped retrying after ${state.failovers} failovers this turn.`,
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
		// A sub-agent's recovery is its own; it must not make the next root run
		// look like a continuation.
		if (agentId) {
			recoveringRuns.add(agentId)
		} else if (!parentAgentId) {
			recoveringRootRun = true
		}

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
	// A model that ignores a reminder, keeps stalling between steps, or keeps
	// failing commands gets swapped. The first stall escalation of a turn goes
	// to the next free model of the route (then the coding route, then the
	// pool): on BalanceAuto the default route's lead is Sonnet 5, and sending
	// the last one or two calls of a 100k-token turn there wrote the whole
	// prefix into its cache for a reply of a hundred tokens. A second stall
	// escalation in the same turn, or six failed commands, go to the default
	// route's lead, the one that keeps acting on long tasks.
	const escalateStuckModel = (reason: "stall" | "failed-commands"): void => {
		if (!isRouted()) {
			return
		}
		const state = rootState()
		const last = state.calls[state.calls.length - 1]
		const current = last?.modelId
		const rules = rulesFor(activeProfile)
		state.escalations += 1
		const inPool = (id: string) => id !== current && rules.pool.includes(id)
		let next: string | undefined
		if (reason === "stall" && state.escalations === 1) {
			const route = rules.routes.find((candidate) => candidate.name === last?.routeName)?.use ?? []
			const coding = rules.routes.find((candidate) => candidate.name === "coding")?.use ?? []
			next = [...route, ...coding, ...rules.pool].find(
				(id) => inPool(id) && isPlinySelfHostedModelId(id) && isModelHealthy(id, now()),
			)
		}
		if (!next) {
			const preferred = rules.routes.find((route) => route.name === "default")?.use ?? []
			next = [...preferred, ...rules.pool].find(inPool)
		}
		if (next && rules.sticky) {
			state.stickyModelId = next
			state.run.escalatedTo = next
			emitInfo(`\`${formatClock(now())}\` ↪ switching to **${modelLabel(next)}** for the rest of the turn`)
			Logger.log(`[FreeAuto] escalation ${state.escalations} (${reason}): sticky model ${current ?? "(none)"} → ${next}`)
		}
	}
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
			escalateStuckModel("stall")
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
		beforeModel: ({ snapshot }) => {
			if (!isRouted()) {
				return
			}
			const position = { ...(snapshot.runId ? { runId: snapshot.runId } : {}), iteration: snapshot.iteration }
			if (snapshot.agentId) {
				runPositions.set(snapshot.agentId, position)
			}
			if (!snapshot.parentAgentId) {
				rootPosition = position
			}
		},
		afterTool: ({ snapshot, tool, toolCall, result }) => {
			if (isRouted() && isSuccessfulEdit(tool.name, result)) {
				const calls = getSessionState(turnKeyFor(snapshot.agentId, snapshot.parentAgentId)).calls
				const author = calls[calls.length - 1]?.modelId
				if (author) {
					turnEdits.authors.add(author)
				}
				if (snapshot.parentAgentId) {
					turnEdits.bySubAgents += 1
				}
			}
			// Hooks run in sub-agents too; judge by the agent that ran the tool.
			if (!freeModelIsAnswering(turnKeyFor(snapshot.agentId, snapshot.parentAgentId))) {
				return undefined
			}
			const observed = shellFailureFromResult({
				type: "tool-result",
				toolCallId: toolCall.toolCallId,
				toolName: tool.name,
				output: result.output,
				...(result.isError ? { isError: true } : {}),
			})
			// `findstr` with no match or `Get-ChildItem` on a missing path exit
			// 1 and print nothing: an answer, not a failure.
			const failure = isExpectedQueryExit(observed) ? undefined : observed
			// Only the root agent's tools feed the completion guard's state.
			if (!snapshot.parentAgentId) {
				const run = rootState().run
				run.toolCalls += 1
				run.previousTool = tool.name
				run.previousToolFailed = failure?.kind === "failed"
				run.previousToolDetached = failure?.kind === "detached"
				if (failure?.kind === "failed") {
					run.failedCommands = (run.failedCommands ?? 0) + 1
					if (run.failedCommands >= FAILED_COMMANDS_BEFORE_ESCALATION && !run.escalated) {
						run.escalated = true
						emitInfo(
							`\`${formatClock(now())}\` ⚠ ${run.failedCommands} commands have failed this turn, so the model may be stuck`,
						)
						escalateStuckModel("failed-commands")
					}
				}
			}
			if (!failure) {
				return undefined
			}
			const noteKey = turnKeyFor(snapshot.agentId, snapshot.parentAgentId)
			const notes = shellNotes.get(noteKey)
			const count = notes && notes.runId === snapshot.runId ? notes.count : 0
			if (count >= SHELL_NOTES_PER_RUN) {
				return undefined
			}
			shellNotes.set(noteKey, { runId: snapshot.runId, count: count + 1 })
			return { appendContext: failure.kind === "failed" ? failedCommandNote(failure) : detachedCommandNote(failure) }
		},
		afterRun: ({ snapshot, result }) => {
			if (!isRouted()) {
				return
			}
			const subAgent = Boolean(snapshot.parentAgentId)
			const state = getSessionState(turnKeyFor(snapshot.agentId, snapshot.parentAgentId))
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
			const totals = callTotals(state.calls)
			const subAgents = turnSubAgents
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
				...(result.runId ? { runId: result.runId } : {}),
				...(totals.usage ? { usage: totals.usage } : {}),
				...(totals.costUsd !== undefined ? { costUsd: totals.costUsd } : {}),
				models: totals.models,
				paidCalls: totals.paidCalls,
				...(totals.paidCostUsd !== undefined ? { paidCostUsd: totals.paidCostUsd } : {}),
				failovers: state.failovers,
				...(!subAgent && subAgents.calls > 0
					? {
							subAgentCalls: subAgents.calls,
							...(subAgents.usage ? { subAgentUsage: subAgents.usage } : {}),
							...(subAgents.costUsd !== undefined ? { subAgentCostUsd: subAgents.costUsd } : {}),
						}
					: {}),
			})
			if (subAgent && snapshot.agentId) {
				runPositions.delete(snapshot.agentId)
			}
		},
	})

	// Compaction summaries talk to the gateway directly, so they must never be
	// handed the virtual router id. The rules file has not loaded yet at this
	// point, so the summarizer starts on the built-in default and is updated in
	// place once the file is read: core keeps a reference to this object rather
	// than a copy.
	//
	// Whether compaction runs at all is the session factory's decision: it
	// leaves `compaction` out when the user turned auto-condense off, and that
	// must stay off on a router too. The summarizer is still attached, so a
	// later rebuild that turns compaction on finds it.
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
			enabled: config.compaction?.enabled ?? false,
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
	run: { turnKey: string; isSubAgent: boolean; mode: RouterMode },
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
