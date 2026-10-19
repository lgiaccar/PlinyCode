import type { CoreSessionConfig } from "@plinycode/core"
import { type AgentStopControl, createSessionId } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { StateManager } from "@/core/storage/StateManager"
import { isReviewBeforeFinishEnabled } from "@/hosts/vscode/review-settings"
import { type AdvisorInstallDeps, installAdvisor } from "./advisor/advisor-install"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import type { ConversationGitSnapshots } from "./context/conversation-git-snapshots"
import type { ConversationPromptDates } from "./context/conversation-prompt-date"
import { installInstructionContextRows } from "./instruction-context-rows"
import { installLastRequestCapture } from "./last-model-request"
import type { ConversationMemorySnapshots } from "./memory/conversation-memory-snapshots"
import { installMemory, type MemoryInstallDeps } from "./memory/install-memory"
import { installRouter, type RouterImageDeps, type RouterInstallDeps } from "./router/router-integration"
import type { PastedCommandBodies } from "./slash-command-expansion"
import { installSessionTrace, type SessionTrace, type SessionTraceDeps } from "./trace/session-trace"

interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
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
	 * Whether a session runs in the background. Its routing and mistake-limit
	 * rows are dropped instead of landing in the displayed task.
	 */
	isBackgroundSession?: (sessionId: string | undefined) => boolean
	/** True while the session's running turn answers an off-the-record side question, which edits nothing. */
	isOffTheRecordTurn?: (sessionId: string | undefined) => boolean
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
	 * Supplies the date for the system prompt's <env> block: fixed when the
	 * conversation starts and reused on every later build, for the same
	 * reason as the git snapshot.
	 */
	promptDates?: Pick<ConversationPromptDates, "prepare">
	/**
	 * The conversation a config is being built for: the displayed task's id.
	 * Undefined while a new task is starting, which is when a snapshot is
	 * gathered. Every rebuild, resume, compaction and restore builds its config
	 * with its task displayed.
	 */
	getConversationId?: () => string | undefined
	/**
	 * The memory section of the system prompt, read once per conversation like
	 * the git snapshot, and the memory and conversation search tools.
	 */
	memory?: MemoryInstallDeps & { snapshots: Pick<ConversationMemorySnapshots, "prepare"> }
	/** What the routers do with images their models cannot see (`router/router-images.ts`). */
	routerImages?: RouterImageDeps
	/** The advisor tool's settings, budget check and usage sink; the tool is installed when given. */
	advisor?: Pick<AdvisorInstallDeps, "getSettings" | "checkBudget" | "onUsage">
	/** The per-session trace (`<dataDir>/traces/<sessionId>.jsonl`); recorded when given. */
	trace?: SessionTraceDeps
	/**
	 * The workflow and built-in skill bodies a slash command can paste, read
	 * before every model call so the context breakdown counts them apart
	 * from the conversation.
	 */
	pastedCommandBodies?: () => PastedCommandBodies
}

/**
 * Unlike the CLI interactive runtime, plan-mode sessions do NOT expose a
 * switch_to_act_mode tool: matching the legacy extension, the model cannot
 * switch modes itself and must ask the user to flip the mode switch. The
 * plan-mode system prompt (planModeSwitchTool: false in the session factory)
 * carries the matching instructions.
 */
export class SdkSessionConfigBuilder {
	/** Conversations that run on a model of their own (CI board runs), by conversation id. */
	private readonly pinnedModels = new Map<string, string>()

	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	/**
	 * Keeps a conversation on `modelId` through every rebuild (mode, MCP,
	 * compaction, resume), whatever model the chat selects.
	 */
	pinModel(conversationId: string, modelId: string): void {
		this.pinnedModels.set(conversationId, modelId)
	}

	pinnedModel(conversationId: string | undefined): string | undefined {
		return conversationId ? this.pinnedModels.get(conversationId) : undefined
	}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		// A conversation started in the background is not the displayed one, so
		// it must not pick up the displayed task's snapshots or pinned model.
		const conversationId = input.newConversation ? undefined : this.options.getConversationId?.()?.trim() || undefined
		const [git, date, memory] = await Promise.all([
			this.options.gitSnapshots?.prepare(conversationId, input.cwd),
			this.options.promptDates?.prepare(conversationId),
			this.options.memory?.snapshots.prepare(conversationId, input.cwd),
		])
		const modelId = input.modelId?.trim() || this.pinnedModel(conversationId)
		const config = await buildSessionConfig({
			...input,
			...(modelId ? { modelId } : {}),
			...(git?.snapshot ? { gitSnapshot: git.snapshot } : {}),
			...(date ? { currentDate: date.date } : {}),
			...(memory?.section ? { memorySection: memory.section } : {}),
		})
		// A session id is fixed up front so per-session emitters below can tell
		// whether their session runs in the background. Callers that reuse an
		// existing id overwrite config.sessionId; the emitters read it lazily.
		config.sessionId = config.sessionId?.trim() || createSessionId()
		git?.bindToSession(config.sessionId)
		date?.bindToSession(config.sessionId)
		memory?.bindToSession(config.sessionId)
		// What only the host can name in a request, for the usage report's context breakdown
		// (docs/context-compaction.md): the memory section it appended to the system prompt and the
		// bodies its slash commands paste. The engine adds the rules and finds the tools itself.
		const memoryText = memory?.section
		const pastedBodies = this.options.pastedCommandBodies
		config.contextSources = () => ({
			...(memoryText ? { memoryText } : {}),
			...(pastedBodies?.() ?? {}),
		})
		const isBackground = () => this.options.isBackgroundSession?.(config.sessionId) === true

		const onMistakeLimit = this.options.onConsecutiveMistakeLimitReached
		if (onMistakeLimit) {
			config.onConsecutiveMistakeLimitReached = (context) =>
				isBackground() ? { action: "stop", reason: `mistake_limit_reached: ${context.reason}` } : onMistakeLimit(context)
		}

		// Hook files are run by the engine, not by a config hook: see
		// VscodeSessionHost's prepareStartSessionInput and hook-status-rows.ts.
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
		// Installed below, after the router and the advisor; the router reports
		// its decisions to it through this forwarder, which is bound by then.
		let trace: SessionTrace | undefined
		if (emitRow && nextMessageTs) {
			// Shows which rules and skills each turn's request carries, for
			// every model: the row is how a user learns a rules file was not
			// picked up without waiting for the model to ignore it.
			installInstructionContextRows(config, { emitRow, nextMessageTs })
			const getRunChanges = this.options.getRunChanges
			installRouter(config, {
				sessionId: (input.newConversation ? config.sessionId : this.options.getSessionId?.()) || input.cwd,
				// The id this config's session runs under, once it runs: the router's
				// state must be found under it when the turn summary is emitted.
				getSessionId: () => config.sessionId,
				workspaceRoot: input.workspaceRoot ?? input.cwd,
				// Ask mode routes as "ask": it reads and answers like plan mode but takes the
				// thinking route only for questions that ask for reasoning. So does a side
				// question, which runs under ask mode's rules whatever the mode is: it gets
				// no completion judge and no review.
				//
				// The mode is the session's own, fixed when its config was built: the mode
				// switch rebuilds the displayed session, and a background or CI Board task
				// keeps the mode it was started in whatever the switch shows.
				getMode: () => {
					if (this.options.isOffTheRecordTurn?.(config.sessionId)) {
						return "ask"
					}
					const sessionMode = input.mode ?? this.options.stateManager.getGlobalSettingsKey("mode")
					return sessionMode === "act" ? "act" : sessionMode === "ask" ? "ask" : "plan"
				},
				emitRow,
				nextMessageTs,
				reviewEnabled: isReviewBeforeFinishEnabled,
				// The id is read when the review runs: a new session's is only final once it has started.
				...(getRunChanges ? { getRunChanges: () => getRunChanges(config.sessionId ?? "") } : {}),
				...(this.options.trace ? { onCallEvent: (event) => trace?.recordRouterEvent(event) } : {}),
				...(this.options.routerImages ? { images: this.options.routerImages } : {}),
			})
		}

		if (this.options.memory) {
			installMemory(config, input.cwd, this.options.memory)
		}

		// After the router, so the advisor's model factory wraps the router's.
		if (this.options.advisor) {
			installAdvisor(config, {
				...this.options.advisor,
				// The same key installRouter uses above.
				routerSessionKey: () =>
					config.sessionId?.trim() || (input.newConversation ? undefined : this.options.getSessionId?.()) || input.cwd,
			})
		}

		// After the router and the advisor, so it sees the requests they pass on
		// and the tool hooks they installed.
		if (this.options.trace) {
			trace = installSessionTrace(config, this.options.trace)
		}

		// Outermost, so it records the request every other wrapper passes on.
		installLastRequestCapture(config)

		return config
	}
}
