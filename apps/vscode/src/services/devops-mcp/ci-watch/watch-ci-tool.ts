/**
 * `watch_ci`: registers a CI watch for the conversation and returns at once.
 *
 * It is a tool of the extension, not of the DevOps MCP server: the server is
 * also registered with Copilot Chat and Cursor, which have no way to receive
 * the result later. That is also why the advice to use it instead of polling
 * lives in this description and not in the server's instructions.
 */
import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import { WATCH_CI_STARTED_PREFIX, WATCH_CI_TOOL_NAME } from "@shared/ciWatch"
import type { CiWatchManager } from "./ci-watch-manager"
import { type CiWatchRepoOpener, createCiWatchSource, resolveCiWatchTarget } from "./ci-watch-source"
import type { CiWatchUntil } from "./ci-watcher"

interface WatchCiToolOptions {
	/** The session's working directory: the repository whose CI is watched. */
	cwd: string
	manager: CiWatchManager
	openRepo: CiWatchRepoOpener
}

interface WatchCiInput {
	pr?: number | string
	branch?: string
	until?: string
	cancel?: boolean | string
}

/** Free models send numbers as strings, like they do to the server's tools. */
function prNumber(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined
	}
	const id = typeof value === "number" ? value : Number.parseInt(String(value).replace(/^#/, ""), 10)
	if (!Number.isInteger(id) || id <= 0) {
		throw new Error(`\`pr\` must be a pull request number, got ${JSON.stringify(value)}.`)
	}
	return id
}

/**
 * The tools the CI watcher adds to a session: `watch_ci`, unless
 * `plinycode.ci.watch` is off or no controller is there to receive the result.
 */
export function ciWatchTools(
	options: Omit<WatchCiToolOptions, "manager"> & { enabled: boolean; manager?: CiWatchManager },
): AgentTool[] {
	return options.enabled && options.manager ? [createWatchCiTool({ ...options, manager: options.manager })] : []
}

export function createWatchCiTool(options: WatchCiToolOptions): AgentTool {
	return {
		name: WATCH_CI_TOOL_NAME,
		description:
			"Watch the CI runs (GitHub Actions or Azure Pipelines) of a pull request or branch in the background, and " +
			"receive the result as a new message in this conversation when they end. Call it after pushing a change " +
			"whose CI result matters, instead of the wait tool and instead of polling pipeline_runs or pr_checks: " +
			"watching runs outside the conversation and costs no tokens. It returns at once. Then finish your turn, " +
			"saying that you are waiting for CI, and do not poll. The result arrives as a message that starts with " +
			"[CI WATCHER], with how many runs passed and failed, the failed jobs and steps and the log lines around " +
			"each failure. By default it watches the open pull request of the current branch, or the branch's pushed " +
			"head commit when it has none, and it follows new pushes. A conversation has one watch: calling watch_ci " +
			"again replaces it, and `cancel: true` stops it. A watch ends by itself after 2 hours, and is lost if the " +
			"editor window reloads.",
		inputSchema: {
			type: "object",
			properties: {
				pr: {
					type: "number",
					description: "Number/ID of the pull request to watch. Defaults to the open pull request of `branch`.",
				},
				branch: {
					type: "string",
					description:
						"Branch to watch: its open pull request if it has one, otherwise its pushed head commit. Defaults to the current branch.",
				},
				until: {
					type: "string",
					enum: ["finished", "first_failure"],
					description:
						'"finished" (the default) reports when every run has ended; "first_failure" reports as soon as one run fails.',
				},
				cancel: {
					type: "boolean",
					description: "Stop this conversation's watch instead of starting one.",
				},
			},
		},
		// Registering twice would only replace the watch with itself, but a failed
		// lookup should reach the model as it is rather than be repeated.
		retryable: false,
		timeoutMs: 120_000,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as WatchCiInput
			const conversationId = context.sessionId ?? context.conversationId
			// A sub-agent's run ends before CI does, and the result belongs in the conversation the user sees.
			if (!conversationId || context.snapshot?.parentAgentId) {
				throw new Error("watch_ci can only be called by the main agent of a conversation.")
			}
			if (input.cancel === true || input.cancel === "true") {
				const stopped = options.manager.cancel(conversationId)
				return stopped ? `Stopped watching CI for ${stopped}.` : "This conversation has no CI watch to stop."
			}
			const until: CiWatchUntil = input.until === "first_failure" ? "first_failure" : "finished"
			const repo = await options.openRepo(options.cwd)
			const target = await resolveCiWatchTarget(repo, {
				pr: prNumber(input.pr),
				branch: typeof input.branch === "string" ? input.branch.trim() || undefined : undefined,
			})
			const replaced = options.manager.watch(conversationId, {
				source: createCiWatchSource(repo, target),
				label: target.label,
				providerKind: repo.provider.kind,
				head: target.head,
				until,
			})
			return [
				`${WATCH_CI_STARTED_PREFIX} for ${target.label} at commit ${target.head.slice(0, 8)} on ${repo.provider.kind}, ` +
					(until === "first_failure" ? "until a run fails or all of them finish." : "until every run has finished."),
				replaced ? `This replaces the previous watch on ${replaced}.` : undefined,
				...target.warnings.map((warning) => `Warning: ${warning} CI does not run for commits that are not pushed.`),
				"Do not poll and do not call wait. Finish your turn now and tell the user you are waiting for CI. " +
					"The result will arrive in this conversation as a new message that starts with [CI WATCHER].",
			]
				.filter(Boolean)
				.join("\n")
		},
	}
}
