import { createUserInstructionConfigService, type UserInstructionConfigService } from "@plinycode/core"
import { mentionRegexGlobal } from "@shared/context-mentions"
import { parseMentions } from "@/core/mentions"
import type { StateManager } from "@/core/storage/StateManager"
import type { WorkspaceRootManager } from "@/core/workspace/WorkspaceRootManager"
import { getMemoryMaxTokens } from "@/hosts/vscode/memory-settings"
import { UrlContentFetcher } from "@/services/browser/UrlContentFetcher"
import { Logger } from "@/shared/services/Logger"
import { builtinSlashCommands } from "./builtin-slash-commands"
import { buildDisabledWorkflowNames, expandSlashCommands } from "./slash-command-expansion"

export interface SdkSlashMentionResolverOptions {
	stateManager: StateManager
	getWorkspaceRoot: () => Promise<string>
	ensureWorkspaceManager: () => Promise<WorkspaceRootManager | undefined>
}

/**
 * Expands `/workflow` and `/skill` slash commands and resolves `@` context
 * mentions in user text before it reaches the SDK. Extracted from
 * SdkController, which owns the disposal lifecycle (see
 * invalidateUserInstructionService, called from Controller.dispose()).
 */
export class SdkSlashMentionResolver {
	// Watches user-instruction files (workflows/skills/rules). Used to expand
	// `/workflow` and `/skill` slash commands into their instruction bodies before
	// the prompt reaches the model — the same mechanism the CLI uses in
	// `buildUserInputMessage`. The agent loop never auto-expands commands, so this
	// host-side expansion is required. Created lazily (memoized as a promise to be
	// race-free under concurrent first sends) and rebuilt if the workspace root
	// changes.
	private userInstructionService?: Promise<UserInstructionConfigService>
	private userInstructionServiceRoot?: string
	private isDisposed = false

	constructor(private readonly options: SdkSlashMentionResolverOptions) {}

	async invalidateUserInstructionService(): Promise<void> {
		const userInstructionServicePromise = this.userInstructionService
		this.userInstructionService = undefined
		this.userInstructionServiceRoot = undefined
		if (userInstructionServicePromise) {
			await userInstructionServicePromise.then((service) => service.stop()).catch(() => {})
		}
	}

	async dispose(): Promise<void> {
		this.isDisposed = true
		await this.invalidateUserInstructionService()
	}

	/**
	 * Lazily create (or rebuild on workspace-root change) the user-instruction
	 * watcher. Pointed at the workspace root so it discovers both local config
	 * (`.clinerules/workflows`, `.cline/workflows`, …).
	 *
	 * `workspaceRoot` is resolved by the caller so the memoization check below runs
	 * synchronously on entry — there is no `await` before the assignment, so
	 * concurrent callers cannot create two competing watchers.
	 */
	private ensureUserInstructionService(workspaceRoot: string): Promise<UserInstructionConfigService> {
		// dispose() may have run during an awaited gap in the caller. Don't
		// resurrect a watcher the dispose path will never stop again.
		if (this.isDisposed) {
			return Promise.reject(new Error("Controller disposed"))
		}
		if (this.userInstructionService && this.userInstructionServiceRoot === workspaceRoot) {
			return this.userInstructionService
		}
		// Workspace root changed: stop the previous watcher once it settles.
		const previous = this.userInstructionService
		if (previous) {
			previous.then((service) => service.stop()).catch(() => {})
		}
		this.userInstructionServiceRoot = workspaceRoot
		this.userInstructionService = (async () => {
			const service = createUserInstructionConfigService({
				workflows: { workspacePath: workspaceRoot },
				skills: {
					workspacePath: workspaceRoot,
					includePluginSkills: true,
					cwd: workspaceRoot,
				},
				rules: { workspacePath: workspaceRoot },
			})
			// start() runs the initial scan; await so the snapshot is populated
			// before the first resolveRuntimeSlashCommand call.
			await service.start().catch((error) => {
				Logger.warn("[SdkController] Failed to start user instruction watcher:", error)
			})
			return service
		})()
		return this.userInstructionService
	}

	/**
	 * Expand a `/workflow` or `/skill` slash command into its instruction body.
	 * Serves the same purpose as the CLI's `buildUserInputMessage`, but is more
	 * permissive than the SDK's leading-only resolver: it accepts the legacy
	 * `/my-workflow.md` spelling the webview autocomplete inserts, matches
	 * commands mid-message (anything the chat input highlights as a command),
	 * and honors the user's workflow enable/disable toggles. Returns the input
	 * unchanged if no known command matches or expansion fails.
	 */
	private async resolveSlashCommands(text: string): Promise<string> {
		if (this.isDisposed) {
			return text
		}
		try {
			const workspaceRoot = await this.options.getWorkspaceRoot()
			const service = await this.ensureUserInstructionService(workspaceRoot)
			const workflowRecords = service.listRecords("workflow").map((record) => ({
				id: record.id,
				name: record.item.name,
				filePath: record.filePath,
			}))
			const disabledWorkflowNames = buildDisabledWorkflowNames({
				records: workflowRecords,
				globalToggles: this.options.stateManager.getGlobalSettingsKey("globalWorkflowToggles"),
				workspaceToggles: this.options.stateManager.getWorkspaceStateKey("workflowToggles"),
			})
			const builtins = builtinSlashCommands({ memoryEnabled: getMemoryMaxTokens() > 0 })
			return expandSlashCommands(text, [...service.listRuntimeCommands(), ...builtins], {
				disabledWorkflowNames,
				workflowRecords,
			})
		} catch (error) {
			Logger.warn("[SdkController] Slash command resolution failed, using raw text:", error)
			return text
		}
	}

	/**
	 * Expand slash commands, then resolve `@` context mentions in user text
	 * before sending to the SDK.
	 *
	 * `parseMentions()` inlines file content (`@/path`), URL content
	 * (`@https://...`), diagnostics (`@problems`), git state (`@git-changes`),
	 * and commit info (`@hash`) into the prompt text. We do this here because
	 * the SDK's own mention enricher only handles simple `@path` file mentions
	 * and does not understand the webview's `@/path` format or special
	 * mentions, so the LLM would otherwise never see the referenced content.
	 */
	async resolveContextMentions(text: string): Promise<string> {
		const withCommands = await this.resolveSlashCommands(text)

		// Quick check: skip mention parsing if there are no @ mentions
		if (!mentionRegexGlobal.test(withCommands)) {
			return withCommands
		}
		// Reset lastIndex since RegExp.test() advances it for global regexes
		mentionRegexGlobal.lastIndex = 0

		try {
			const cwd = await this.options.getWorkspaceRoot()
			const urlContentFetcher = new UrlContentFetcher()
			const workspaceManager = await this.options.ensureWorkspaceManager()
			const resolved = await parseMentions(withCommands, cwd, urlContentFetcher, undefined, workspaceManager)
			Logger.log(`[SdkController] Resolved context mentions (${withCommands.length} → ${resolved.length} chars)`)
			return resolved
		} catch (error) {
			Logger.error("[SdkController] Failed to resolve context mentions, using raw text:", error)
			return withCommands
		}
	}
}
