import type { CoreSessionConfig } from "@plinycode/core"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { StateManager } from "@/core/storage/StateManager"
import { buildSessionConfig, type SessionConfigInput } from "./cline-session-factory"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"
import { installRouter } from "./router/router-integration"

export interface SdkSessionConfigBuilderOptions {
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
		const config = await buildSessionConfig(input)
		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		config.hooks = buildAgentHooks(this.options.stateManager, this.options.emitHookMessage, input.cwd)

		// FreeAuto routing. Installed for every session: it is a passthrough
		// unless the selected model is the virtual router, and installing it
		// unconditionally means switching to FreeAuto mid-task works without a
		// session rebuild.
		const emitRow = this.options.emitRow
		const nextMessageTs = this.options.nextMessageTs
		if (emitRow && nextMessageTs) {
			installRouter(config, {
				sessionId: this.options.getSessionId?.() || input.cwd,
				workspaceRoot: input.workspaceRoot ?? input.cwd,
				getMode: () => (this.options.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"),
				emitRow,
				nextMessageTs,
			})
		}

		return config
	}
}
