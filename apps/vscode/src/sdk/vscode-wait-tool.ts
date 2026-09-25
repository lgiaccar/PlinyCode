/**
 * `wait`: lets the agent pause for a bounded time and then look again.
 *
 * Without it a model that starts a long build or benchmark has no way to pass
 * time: a foreground command is detached after 300 s, `Start-Sleep 600` with
 * it, and the only remaining move is to end the turn with "I'll check back in
 * ten minutes" — which nothing ever does. With it the loop becomes wait → read
 * the log → wait again, entirely inside the run.
 *
 * Bounded twice: per call (`maxSeconds`) so a single wait cannot hang a turn,
 * and per run (`maxTotalSecondsPerRun`) so a model cannot sleep through an
 * afternoon; past the budget the tool answers with an error telling the model
 * to ask the user. Aborting the run, or a steering message from the user,
 * ends the wait at once.
 */

import type { AgentTool, AgentToolContext } from "@plinycode/shared"

export const WAIT_TOOL_NAME = "wait"
export const WAIT_TOOL_MAX_SECONDS = 600
export const WAIT_TOOL_MAX_TOTAL_SECONDS_PER_RUN = 3600

export interface WaitToolInput {
	/** Seconds to wait, 1..maxSeconds. */
	seconds: number
	/** What the agent is waiting for; echoed back and shown in the chat row. */
	reason?: string
}

export interface WaitToolOptions {
	maxSeconds?: number
	maxTotalSecondsPerRun?: number
	/** Injectable for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<"done" | "aborted">
	now?: () => number
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<"done" | "aborted"> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve("aborted")
			return
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve("done")
		}, ms)
		function onAbort() {
			clearTimeout(timer)
			resolve("aborted")
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

function clampSeconds(value: unknown, max: number): number {
	const seconds = typeof value === "number" ? value : Number.parseFloat(String(value))
	if (!Number.isFinite(seconds) || seconds < 1) {
		return 1
	}
	return Math.min(Math.round(seconds), max)
}

export function createWaitTool(options: WaitToolOptions = {}): AgentTool {
	const maxSeconds = options.maxSeconds ?? WAIT_TOOL_MAX_SECONDS
	const maxTotal = options.maxTotalSecondsPerRun ?? WAIT_TOOL_MAX_TOTAL_SECONDS_PER_RUN
	const sleep = options.sleep ?? defaultSleep
	const now = options.now ?? (() => Date.now())
	// Seconds already waited, per run. Runs are keyed by runId; a context
	// without one shares a single budget.
	const waitedPerRun = new Map<string, number>()

	return {
		name: WAIT_TOOL_NAME,
		description:
			`Pause for up to ${maxSeconds} seconds, then continue. Use it to wait for a command you started in the ` +
			"background (a build, a test run, a benchmark) before checking its log or status again. Your turn ends the " +
			"moment you reply without a tool call and nothing runs for you afterwards, so never end a reply with " +
			'"I\'ll check back later": call wait, then read the log or run a status command, and repeat until the job ' +
			`finishes or you hit a concrete blocker. At most ${Math.round(maxTotal / 60)} minutes of waiting per turn; ` +
			"if the job needs longer, ask the user whether to keep polling.",
		inputSchema: {
			type: "object",
			properties: {
				seconds: {
					type: "number",
					description: `How long to wait, in seconds (1-${maxSeconds}).`,
					minimum: 1,
					maximum: maxSeconds,
				},
				reason: {
					type: "string",
					description: "What you are waiting for, in a few words.",
				},
			},
			required: ["seconds"],
		},
		// Waiting is inert: nothing to approve, nothing to retry.
		retryable: false,
		timeoutMs: (maxSeconds + 60) * 1000,
		// Typed `unknown` like every runtime tool: the model's arguments are only
		// as trustworthy as the schema it was shown, and clampSeconds copes.
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as Partial<WaitToolInput>
			const key = context.runId ?? "(no run)"
			const alreadyWaited = waitedPerRun.get(key) ?? 0
			const remaining = maxTotal - alreadyWaited
			if (remaining <= 0) {
				throw new Error(
					`Wait budget exhausted: this turn has already waited ${Math.round(alreadyWaited / 60)} minutes. ` +
						"Do not wait further. Report the current state to the user and ask whether to keep polling.",
				)
			}
			const requested = clampSeconds(input.seconds, maxSeconds)
			const seconds = Math.min(requested, remaining)
			const startedAt = now()
			// A steering message from the user ends the wait too: the agent must
			// read it now, not after up to ten minutes of sleep.
			const signals = [context.signal, context.userMessageSignal].filter((signal): signal is AbortSignal => !!signal)
			const outcome = await sleep(seconds * 1000, signals.length > 1 ? AbortSignal.any(signals) : signals[0])
			const waited = Math.round((now() - startedAt) / 1000)
			waitedPerRun.set(key, alreadyWaited + waited)
			if (outcome === "aborted") {
				if (context.userMessageSignal?.aborted && !context.signal?.aborted) {
					return `Wait ended after ${waited} s because the user sent a new message. Read it and act on it before waiting again.`
				}
				return `Wait cancelled after ${waited} s.`
			}
			const clamped = requested !== clampSeconds(input.seconds, Number.POSITIVE_INFINITY) || seconds !== requested
			const budgetLeft = Math.max(0, maxTotal - alreadyWaited - waited)
			return [
				`Waited ${waited} s${input.reason ? ` for: ${input.reason}` : ""}.`,
				clamped
					? `(Requested ${input.seconds} s; each wait is capped at ${maxSeconds} s and this turn has ${Math.round(budgetLeft / 60)} min of waiting left.)`
					: undefined,
				`It is now ${new Date(now()).toISOString()}.`,
				"Now check progress with a tool call: read the log file or run a status command. If the job is still running, call wait again.",
			]
				.filter(Boolean)
				.join("\n")
		},
	}
}
