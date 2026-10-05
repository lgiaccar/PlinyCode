import type { CoreSessionConfig } from "@plinycode/core"
import { type AgentStopControl, createSessionId } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { StateManager } from "@/core/storage/StateManager"
import { isReviewBeforeFinishEnabled } from "@/hosts/vscode/review-settings"
import { type AdvisorInstallDeps, installAdvisor } from "./advisor/advisor-install"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import type { ConversationGitSnapshots } from "./context/conversation-git-snapshots"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"
import { installInstructionContextRows } from "./instruction-context-rows"
import { installRouter, type RouterInstallDeps } from "./router/router-integration"

interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
	/**
	 * Session id the config is being built for. Read lazily because a new
	 * session's id is only known once it starts; the router uses it to key its
	 * per-turn state.
	 */
	getSessionId?: () => string
	/** Emits a chat row (routing notices, failovers, turn summary). */
	emitRow?: (message: ClineMessage) => void
	/** Mints unique, monotonic message ids from the shared authority. */
	nextMessageTs?: () => number
	/**
	 * Whether a session runs in the background. Its hook, routing and
	 * mistake-limit rows are dropped instead of landing in the displayed task.
	 */
	isBackgroundSession?: (sessionId: string | undefined) => boolean
	/**
	 * Called before every model call of a foreground session. Returning a
	 * stop control ends the run there (the conversation spending limit).
	 */
	checkSpendingLimit?: () => Promise<AgentStopControl | undefined>
	/**
	 * What a session's current run has changed, from its checkpoint. The
	 * reviewer pass reads it before a routed run ends; without it, or without
	 * a checkpoint, the pass works from the run's edit calls.
	 */
	getRunChanges?: (sessionId: string) => ReturnType<NonNullable<RouterInstallDeps["getRunChanges"]>>
	/**
	 * Supplies the git snapshot for the system prompt: gathered once per
	 * conversation and reused on every later build, so rebuilds and resumes
	 * keep the prompt's cached prefix.
	 */
	gitSnapshots?: Pick<ConversationGitSnapshots, "prepare">
	/**
	 * The conversation a config is being built for: the displayed task's id.
	 * Undefined while a new task is starting, which is when a snapshot is
	 * gathered. Every rebuild, resume, compaction and restore builds its config
	 * with its task displayed.
	 */
	getConversationId?: () => string | undefined
	/** The advisor tool's settings, budget check and usage sink; the tool is installed when given. */
	advisor?: Pick<AdvisorInstallDeps, "getSettings" | "checkBudget" | "onUsage">
}

/**
 * Unlike the CLI interactive runtime, plan-mode sessions do NOT expose a
 * switch_to_act_mode tool: matching the legacy extension, the model cannot
 * switch modes itself and must ask the user to flip the Plan/Act toggle. The
 * plan-mode system prompt (planModeSwitchTool: false in the session factory)
 * carries the matching instructions.
 */
export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		const git = await this.options.gitSnapshots?.prepare(this.options.getConversationId?.()?.trim() || undefined, input.cwd)
		const config = await buildSessionConfig(git?.snapshot ? { ...input, gitSnapshot: git.snapshot } : input)
		// A session id is fixed up front so per-session emitters below can tell
		// whether their session runs in the background. Callers that reuse an
		// existing id overwrite config.sessionId; the emitters read it lazily.
		config.sessionId = config.sessionId?.trim() || createSessionId()
		git?.bindToSession(config.sessionId)
		const isBackground = () => this.options.isBackgroundSession?.(config.sessionId) === true

		const onMistakeLimit = this.options.onConsecutiveMistakeLimitReached
		if (onMistakeLimit) {
			config.onConsecutiveMistakeLimitReached = (context) =>
				isBackground() ? { action: "stop", reason: `mistake_limit_reached: ${context.reason}` } : onMistakeLimit(context)
		}

		const emitHookMessage = this.options.emitHookMessage
		config.hooks = buildAgentHooks(
			this.options.stateManager,
			(message) => {
				if (!isBackground()) {
					emitHookMessage(message)
				}
			},
			input.cwd,
		)

		const checkSpendingLimit = this.options.checkSpendingLimit
		if (checkSpendingLimit) {
			const baseBeforeModel = config.hooks?.beforeModel
			config.hooks = {
				...(config.hooks ?? {}),
				beforeModel: async (context) => {
					const baseResult = await baseBeforeModel?.(context)
					if (baseResult?.stop || isBackground()) {
						return baseResult
					}
					const limitStop = await checkSpendingLimit()
					return limitStop?.stop ? { ...(baseResult ?? {}), ...limitStop } : baseResult
				},
			}
		}

		// FreeAuto routing. Installed for every session: it is a passthrough
		// unless the selected model is the virtual router, and installing it
		// unconditionally means switching to FreeAuto mid-task works without a
		// session rebuild.
		const baseEmitRow = this.options.emitRow
		const emitRow = baseEmitRow
			? (message: ClineMessage) => {
					if (!isBackground()) {
						baseEmitRow(message)
					}
				}
			: undefined
		const nextMessageTs = this.options.nextMessageTs
		if (emitRow && nextMessageTs) {
			// Shows which rules and skills each turn's request carries, for
			// every model: the row is how a user learns a rules file was not
			// picked up without waiting for the model to ignore it.
			installInstructionContextRows(config, { emitRow, nextMessageTs })
			const getRunChanges = this.options.getRunChanges
			installRouter(config, {
				sessionId: this.options.getSessionId?.() || input.cwd,
				workspaceRoot: input.workspaceRoot ?? input.cwd,
				// Ask mode routes like plan mode: both read and reason, neither edits.
				getMode: () => (this.options.stateManager.getGlobalSettingsKey("mode") === "act" ? "act" : "plan"),
				emitRow,
				nextMessageTs,
				reviewEnabled: isReviewBeforeFinishEnabled,
				// The id is read when the review runs: a new session's is only final once it has started.
				...(getRunChanges ? { getRunChanges: () => getRunChanges(config.sessionId ?? "") } : {}),
			})
		}

		// After the router, so the advisor's model factory wraps the router's.
		if (this.options.advisor) {
			installAdvisor(config, {
				...this.options.advisor,
				// The same key installRouter is given above.
				routerSessionKey: this.options.getSessionId?.() || input.cwd,
			})
		}

		return config
	}
}
