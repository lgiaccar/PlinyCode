/**
 * Custom `run_commands` tool that replaces the SDK's built-in version.
 *
 * This is an IDE-level feature built on top of the SDK, NOT part of the SDK.
 * It supports two execution modes, switchable dynamically per invocation:
 *
 *   - **Foreground (vscodeTerminal):** Uses VscodeTerminalManager for visible
 *     VS Code terminals with shell integration.
 *
 *   - **Background (backgroundExec):** Delegates to the SDK's createShellExecutor()
 *     for headless child_process.spawn execution.
 *
 * With a ProcessRegistry, a terminal command handed over while still running
 * is registered as a background process, and `background: true` starts a
 * command as a child process that the call does not wait for
 * (docs/agent-tools.md, "Background processes").
 */

import {
	COMMAND_DIGEST_THRESHOLD_CHARS,
	CommandAbortedError,
	CommandExitError,
	createShellExecutor,
	createShellTool,
	digestCommandOutput,
	MAX_COMMAND_OUTPUT_CHARS,
	type ShellExecutor,
	type StructuredCommandInput,
	truncateCommandOutput,
} from "@plinycode/core"
import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import { ClineTempManager } from "@services/temp"
import * as fs from "fs"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { AGENT_TERMINAL_ENV } from "@/hosts/vscode/terminal/agent-terminal-env"
import {
	disableNarrowTerminalWarning,
	isNarrowTerminalWarningEnabled,
	readTerminalLocation,
	setTerminalLocation,
	type TerminalLocation,
} from "@/hosts/vscode/terminal/terminal-location"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { INPUT_PROMPT_IDLE_TIMEOUT, MAX_UNRETRIEVED_LINES } from "@/integrations/terminal/constants"
import {
	getUnobservedTerminalCommandDisposition,
	type ITerminalProcess,
	type TerminalCompletionDetails,
	type TerminalInfo,
} from "@/integrations/terminal/types"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { getShellForProfile } from "@/utils/shell"
import type { ProcessRegistry } from "./processes/process-registry"
import { processConversationId } from "./processes/process-tools"
import type { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShellCommand = string | StructuredCommandInput
type VscodeTerminalExecutionMode = "vscodeTerminal" | "backgroundExec"

/** Foreground VS Code terminals cannot be forcibly terminated; give long-running commands room to finish. */
export const VSCODE_FOREGROUND_RUN_COMMANDS_TIMEOUT_MS = 60 * 60 * 1000

/** Release the agent turn if a foreground command is still running after 300 seconds. */
export const FOREGROUND_COMMAND_AUTO_PROCEED_MS = 300 * 1000

/**
 * Background Exec runs commands without a terminal, so nothing hands a
 * long one over as the terminal does after 5 minutes: it is stopped at this
 * limit instead. The engine's default, 30 seconds, killed ordinary builds.
 */
export const BACKGROUND_EXEC_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Environment for commands spawned without a terminal: the terminal's (no
 * pagers, no prompts) plus a wide COLUMNS, which tools without a terminal to
 * measure (Python's shutil, rich, pytest) lay their output out to instead of 80.
 */
function spawnEnv(shell: string): Record<string, string> {
	return { ...AGENT_TERMINAL_ENV, COLUMNS: "200", SHELL: shell }
}

/**
 * Told to the model in place of the generic "background it yourself" advice.
 * A model that launches a benchmark with Start-Process loses its output and
 * errors, and nested quoting can mangle its arguments: in one FreeAuto run
 * `-Build "cpu_mt,cuda"` arrived as `cpu_mt cuda` and the script threw.
 */
const FOREGROUND_LONG_RUNNING_NOTE =
	`A command still running after ${FOREGROUND_COMMAND_AUTO_PROCEED_MS / 60_000} minutes keeps running in the terminal ` +
	"and the call returns with the output so far and the path of a log file that receives the rest. So run long jobs " +
	"(builds, benchmarks, test suites) as ordinary commands; do not detach them yourself with Start-Process, Start-Job, " +
	"nohup or '&', which hides their output and errors from you. To follow one, call `wait`, then read its log or status files."

/**
 * Cap on the "Proceed While Running" log file. A detached devserver can log
 * for days; once the cap is hit we stop appending and note the truncation.
 * ClineTempManager's periodic cleanup (age + total-size caps) is the backstop
 * for the files themselves.
 */
export const PROCEED_LOG_MAX_BYTES = 10 * 1024 * 1024
const PROCEED_LOG_FINAL_MESSAGE_MAX_CHARS = 4096

/** A `background: true` command still running after this long is stopped, like a runaway process. */
const BACKGROUND_PROCESS_MAX_MS = 24 * 60 * 60 * 1000

/** After Ctrl+C, how long a handed-over terminal command gets to stop before its terminal is closed. */
const TERMINAL_KILL_GRACE_MS = 2000

/** How the model learns about `background`, in place of advice to detach commands by hand. */
const BACKGROUND_ARGUMENT_NOTE =
	"For a server, watcher or other job you do not want to wait for, set `background: true`: the call returns at once " +
	"with a process id, process_output reads its output and process_kill stops it."

/** Options for creating the VSCode run_commands tool. */
interface VscodeRunCommandsToolOptions {
	/** Workspace root directory. */
	cwd: string
	/** Lazy factory for the VscodeTerminalManager. Called once on first foreground use. */
	getTerminalManager: () => VscodeTerminalManager
	/** Timeout passed to the SDK shell tool wrapper and timeout telemetry. */
	bashTimeoutMs?: number
	/** Terminal execution mode captured when this session's tool set is built. */
	vscodeTerminalExecutionMode?: VscodeTerminalExecutionMode
	/**
	 * Registry of in-flight foreground executions, owned by SdkController.
	 * When provided, each foreground command can be detached via the
	 * "Proceed While Running" button. Foreground-only: background (SDK
	 * child_process) executions cannot be detached — their abort signal
	 * kills the process tree.
	 */
	foregroundCommands?: SdkForegroundCommandCoordinator
	/**
	 * The window's background processes, owned by SdkController. When given,
	 * a terminal command handed over while still running is registered there,
	 * and the tool takes a `background` argument.
	 */
	processes?: ProcessRegistry
}

/** Where a command that outlives its tool call is registered. */
interface ProcessTracking {
	registry: ProcessRegistry
	conversationId: string
}

// ---------------------------------------------------------------------------
// Foreground execution — VscodeTerminalManager
// ---------------------------------------------------------------------------

function quoteShellArg(arg: string): string {
	if (arg.length === 0) {
		return "''"
	}
	if (!/[\s"'\\$`!&|;<>(){}[\]*?~]/.test(arg)) {
		return arg
	}
	return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function formatCommandForTerminal(command: ShellCommand): string {
	if (typeof command === "string") {
		return command
	}
	if (!("args" in command)) {
		return command.command
	}
	return [command.command, ...(command.args ?? [])].map(quoteShellArg).join(" ")
}

/**
 * Stream the rest of a detached command's output to a log file: write the
 * lines buffered so far, then append each further 'line' event until
 * 'completed'. The write volume is capped at PROCEED_LOG_MAX_BYTES; the
 * stream is closed when the command completes or its process/acquisition
 * fails. Completion covers command end, Ctrl+C, terminal close, and the
 * markerless fallback.
 */
interface DetachedCommandLog {
	path: string
	attach(process: ITerminalProcess): void
	fail(error: unknown): void
}

/**
 * A temp log file that takes at most PROCEED_LOG_MAX_BYTES of output, plus a
 * short closing line. A detached devserver can log for days; once the cap is
 * hit further writes are refused.
 */
interface CappedLogFile {
	path: string
	/** Appends the text, or returns false (writing nothing) when it would pass the cap. */
	tryWrite(text: string): boolean
	/** Writes the closing line and closes the file. Later calls do nothing. */
	end(message: string): void
}

const LOG_SIZE_CAP_MESSAGE = `[Log size cap of ${PROCEED_LOG_MAX_BYTES} bytes reached; further output is not logged.]`

function openCappedLogFile(prefix: string): CappedLogFile {
	const logFilePath = ClineTempManager.createTempFilePath(prefix)
	const stream = fs.createWriteStream(logFilePath, { flags: "a" })
	stream.on("error", (error) => {
		Logger.error(`[VscodeRunCommands] Failed writing command log ${logFilePath}:`, error)
	})
	let bytesWritten = 0
	let ended = false
	return {
		path: logFilePath,
		tryWrite: (text) => {
			const textBytes = Buffer.byteLength(text)
			if (ended || bytesWritten + textBytes > PROCEED_LOG_MAX_BYTES) {
				return false
			}
			bytesWritten += textBytes
			stream.write(text)
			return true
		},
		end: (message) => {
			if (ended) {
				return
			}
			ended = true
			// Output obeys the strict cap, but reserve a small bounded allowance for
			// the terminal status so a full log never hides completion or failure.
			stream.write(`${message.slice(0, PROCEED_LOG_FINAL_MESSAGE_MAX_CHARS)}\n`)
			stream.end()
		},
	}
}

function createDetachedCommandLog(terminalCommand: string, existingLines: string[]): DetachedCommandLog {
	const file = openCappedLogFile("proceed-while-running")
	const tryWriteLine = (line: string): boolean => file.tryWrite(`${line}\n`)

	let sizeCapReached = !tryWriteLine(`[Running command: ${terminalCommand}]`)
	for (const line of existingLines) {
		if (!tryWriteLine(line)) {
			sizeCapReached = true
			break
		}
	}

	let settled = false
	let removeAttachedListeners = (): void => {}
	const end = (message: string): void => {
		if (settled) {
			return
		}
		settled = true
		removeAttachedListeners()
		file.end(message)
	}

	return {
		path: file.path,
		attach: (process) => {
			const onLine = (line: string): void => {
				// Check the cap before writing: a single huge line (e.g. a dumped
				// binary blob or minified bundle) must not blow past the cap.
				if (!tryWriteLine(line)) {
					tryWriteLine(LOG_SIZE_CAP_MESSAGE)
					process.removeListener("line", onLine)
				}
			}
			const onCompleted = (details?: TerminalCompletionDetails): void => {
				const exitCode = details?.exitCode
				end(
					details?.terminalClosed
						? "[Terminal closed while the command was running; output may be incomplete]"
						: details?.unobservedCommand
							? "[Command completion could not be observed; the command may still be running]"
							: exitCode !== undefined && exitCode !== null
								? `[Command completed with exit code ${exitCode}]`
								: "[Command completed]",
				)
			}
			const onError = (error: Error): void => end(`[Command failed after detaching: ${error.message}]`)
			removeAttachedListeners = () => {
				process.removeListener("line", onLine)
				process.removeListener("completed", onCompleted)
				process.removeListener("error", onError)
			}
			if (sizeCapReached) {
				tryWriteLine(LOG_SIZE_CAP_MESSAGE)
			} else {
				process.on("line", onLine)
			}
			process.once("completed", onCompleted)
			process.once("error", onError)
		},
		fail: (error) => {
			const message = error instanceof Error ? error.message : String(error)
			end(`[Command failed before log capture completed: ${message}]`)
		},
	}
}

/** Below this width, programs' own formatting garbles what the model reads. */
const NARROW_TERMINAL_COLUMNS = 80
/** Where the user was warned in this window: a narrow editor terminal is warned about after a narrow panel one. */
const warnedNarrowTerminalLocations = new Set<TerminalLocation>()

const USE_EDITOR_AREA = "Open Terminals in Editor Area"
const DONT_SHOW_AGAIN = "Don't Show Again"

/**
 * Tells the user, once per window and terminal location, that the terminal
 * is too narrow, with a way out. Commands are not re-run or moved out of the
 * terminal on their own: that would change their shell profile, environment
 * and visibility, which is the user's call.
 */
async function warnAboutNarrowTerminal(columns: number, location: TerminalLocation): Promise<void> {
	const effect =
		`PlinyCode's terminal is only ${columns} columns wide, so commands lay out their output to that width before the ` +
		"model reads it: tables lose columns, and long lines and error messages are broken up."
	const { selectedOption } =
		location === "editor"
			? await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: `${effect} Widen the editor group the terminal is in, or set Terminal Execution Mode to Background Exec in PlinyCode's settings to run commands without a terminal.`,
					options: { items: [DONT_SHOW_AGAIN] },
				})
			: await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: `${effect} Open PlinyCode's terminals in the editor area, where they are as wide as the editor, or widen the terminal panel.`,
					options: { items: [USE_EDITOR_AREA, DONT_SHOW_AGAIN] },
				})
	if (selectedOption === USE_EDITOR_AREA) {
		await setTerminalLocation("editor")
	} else if (selectedOption === DONT_SHOW_AGAIN) {
		await disableNarrowTerminalWarning()
	}
}

/**
 * A note for the model when the terminal is too narrow for output to arrive
 * intact, and a warning for the user the first time it happens in a window.
 *
 * Programs format to the terminal's width before PlinyCode sees a byte:
 * PowerShell lays tables out to fit and breaks error messages mid-word, so no
 * post-processing can restore them. In a 33-column terminal a model spent
 * several calls decoding run-directory paths split across lines.
 */
function narrowTerminalNote(columns: number | undefined, location: TerminalLocation): string | undefined {
	if (columns === undefined || columns >= NARROW_TERMINAL_COLUMNS) {
		return undefined
	}
	if (!warnedNarrowTerminalLocations.has(location) && isNarrowTerminalWarningEnabled()) {
		warnedNarrowTerminalLocations.add(location)
		warnAboutNarrowTerminal(columns, location).catch((error) =>
			Logger.warn(`[VscodeRunCommands] Could not show the narrow-terminal warning: ${error}`),
		)
	}
	return (
		`[The terminal is only ${columns} columns wide. Programs that format to its width (PowerShell tables and error ` +
		"messages, for example) wrapped or cut the output above, so a path or word may be split across lines. When you " +
		"need output intact, pipe it through `Out-String -Width 300` (PowerShell) or write it to a file and read that.]"
	)
}

type DetachReason = "user" | "timeout" | "steer"

function formatDetachedResult(logFilePath: string, output: string, reason: DetachReason, processId?: string): string {
	return [
		reason === "user"
			? "The user chose to proceed while the command is starting or still running in their terminal."
			: reason === "steer"
				? "The user sent a new message while the command was still starting or running, so PlinyCode stopped waiting for it and left it running in the terminal. Read the user's message and act on it first."
				: `The command was still starting or running after ${FOREGROUND_COMMAND_AUTO_PROCEED_MS / 1000} seconds, so PlinyCode automatically proceeded while leaving it running in the terminal.`,
		`This is partial output; further output is being redirected to this file, which you can read to check progress: ${logFilePath}`,
		...(processId ? [`It is tracked as process ${processId}: process_output reads its log and process_kill stops it.`] : []),
		output.length > 0 ? `Output so far:\n${output}` : "No output so far.",
	].join("\n")
}

/** A handed-over terminal command in the ProcessRegistry, before and after its process exists. */
interface TrackedTerminalCommand {
	id: string
	/** The command is running in this terminal: follow its end, and apply a kill asked for before it started. */
	attach(terminalInfo: TerminalInfo, process: ITerminalProcess): void
	/** The command never started. */
	fail(): void
}

function trackTerminalCommand(
	tracking: ProcessTracking,
	terminalManager: VscodeTerminalManager,
	command: string,
	cwd: string,
	logPath: string,
): TrackedTerminalCommand {
	const { registry } = tracking
	let terminalInfo: TerminalInfo | undefined
	// Kills asked for before the command had a terminal, settled once it has one or fails.
	const pendingKills: Array<() => void> = []
	const settlePendingKills = (): void => {
		for (const settle of pendingKills.splice(0)) {
			settle()
		}
	}

	// VS Code cannot kill a terminal's foreground process: send Ctrl+C, and if
	// the command is still running after a grace period, close the terminal.
	const interrupt = async (target: TerminalInfo): Promise<void> => {
		try {
			terminalManager.sendInterrupt(target)
		} catch (error) {
			Logger.warn(`[VscodeRunCommands] Failed to send Ctrl+C to process ${registered.id}: ${error}`)
		}
		await new Promise((resolve) => setTimeout(resolve, TERMINAL_KILL_GRACE_MS))
		if (registry.get(registered.id)?.status === "running" && target.busy) {
			try {
				terminalManager.disposeTerminal(target)
			} catch (error) {
				Logger.warn(`[VscodeRunCommands] Failed to close the terminal of process ${registered.id}: ${error}`)
			}
		}
	}

	const registered = registry.register({
		conversationId: tracking.conversationId,
		command,
		cwd,
		source: "terminal",
		logPath,
		kill: () => (terminalInfo ? interrupt(terminalInfo) : new Promise<void>((resolve) => pendingKills.push(resolve))),
	})

	return {
		id: registered.id,
		attach: (info, process) => {
			terminalInfo = info
			process.once("completed", (details?: TerminalCompletionDetails) => {
				if (details?.unobservedCommand) {
					registry.markLost(registered.id)
				} else {
					registry.markExited(registered.id, typeof details?.exitCode === "number" ? details.exitCode : undefined)
				}
			})
			process.once("error", () => registry.markLost(registered.id))
			if (pendingKills.length > 0) {
				void interrupt(info).finally(settlePendingKills)
			}
		},
		fail: () => {
			registry.markExited(registered.id)
			settlePendingKills()
		},
	}
}

type PreStartControl = "detach" | "abort"

/**
 * Short output is returned whole (up to maxOutputChars). Longer output is saved
 * to a temp file and digested: first lines, error and failure lines, last lines.
 * A build log then costs a few thousand characters per later request, not
 * 48,000, and the model reads the file for anything the digest leaves out.
 */
function digestOrTruncate(output: string, maxOutputChars: number): string {
	if (output.length <= COMMAND_DIGEST_THRESHOLD_CHARS) {
		return truncateCommandOutput(output, { maxChars: maxOutputChars })
	}
	let savedTo: string | undefined
	try {
		savedTo = ClineTempManager.createTempFilePath("command-output")
		fs.writeFileSync(savedTo, output)
	} catch (error) {
		Logger.warn(
			`[VscodeRunCommands] Could not save the full command output: ${error instanceof Error ? error.message : String(error)}`,
		)
		return truncateCommandOutput(output, { maxChars: maxOutputChars })
	}
	return digestCommandOutput(output, { savedTo })
}

/** Exported for direct unit testing of the CommandExitError/terminalClosed mapping. */
export async function executeForeground(
	command: ShellCommand,
	cwd: string,
	terminalManager: VscodeTerminalManager,
	maxOutputChars: number,
	abortSignal?: AbortSignal,
	foregroundCommands?: SdkForegroundCommandCoordinator,
	terminalProfileId?: string,
	sessionId?: string,
	userMessageSignal?: AbortSignal,
	processes?: ProcessTracking,
): Promise<string> {
	const terminalCommand = formatCommandForTerminal(command)
	const abortedError = (output?: string): CommandAbortedError =>
		new CommandAbortedError({ command: terminalCommand, cwd, reason: abortSignal?.reason, output })

	// "Proceed While Running": register a per-invocation handle so the user can
	// detach this command. If they do not act, automatically detach after 300
	// seconds so a long-running command cannot block the agent turn indefinitely.
	// Detaching redirects the remaining output to a log file and resolves the
	// awaited promise; the command keeps running in the user's terminal (and the
	// terminal stays busy until it completes).
	//
	// Registered BEFORE terminal acquisition so every command in a parallel
	// run_commands batch is registered before the user can click the button.
	// A command still awaiting its terminal when the user detaches records the
	// request and applies it the moment its process starts — otherwise that
	// late command would re-block the turn the button just released.
	const state: { phase: "waiting" | "started" | "detached" | "aborted" } = { phase: "waiting" }
	let detachedLog: DetachedCommandLog | undefined
	// The handed-over command in the ProcessRegistry, registered with its log.
	let tracked: TrackedTerminalCommand | undefined
	const track = (logPath: string): TrackedTerminalCommand | undefined =>
		processes ? trackTerminalCommand(processes, terminalManager, terminalCommand, cwd, logPath) : undefined
	let detachReason: DetachReason | undefined
	let applyDetach: ((reason: DetachReason) => void) | undefined
	let resolvePreStartControl!: (control: PreStartControl) => void
	const preStartControl = new Promise<PreStartControl>((resolve) => {
		resolvePreStartControl = resolve
	})
	const requestDetach = (reason: DetachReason): void => {
		if (state.phase === "waiting") {
			state.phase = "detached"
			detachReason = reason
			detachedLog = createDetachedCommandLog(terminalCommand, [])
			tracked = track(detachedLog.path)
			resolvePreStartControl("detach")
		} else if (state.phase === "started") {
			applyDetach?.(reason)
		}
	}
	const unregister = foregroundCommands?.register(
		{
			detach: () => requestDetach("user"),
		},
		sessionId,
	)
	// A task running in the background must not pop its terminal into view,
	// nor open one as an editor tab.
	const reveal = foregroundCommands?.isForegroundSession(sessionId) ?? true
	const location: TerminalLocation = reveal ? readTerminalLocation() : "panel"
	const autoProceedTimer = setTimeout(() => requestDetach("timeout"), FOREGROUND_COMMAND_AUTO_PROCEED_MS)
	// A steering message detaches the command like "Proceed While Running", so
	// the agent reads the message now instead of when the command ends.
	const onUserMessage = (): void => requestDetach("steer")
	userMessageSignal?.addEventListener("abort", onUserMessage, { once: true })
	if (userMessageSignal?.aborted) {
		onUserMessage()
	}
	const onAbort = (): void => {
		if (state.phase === "waiting") {
			state.phase = "aborted"
			resolvePreStartControl("abort")
		} else if (state.phase === "started") {
			applyAbort?.()
		}
	}
	let applyAbort: (() => void) | undefined
	abortSignal?.addEventListener("abort", onAbort, { once: true })
	if (abortSignal?.aborted) {
		onAbort()
	}

	try {
		const terminalPromise = terminalManager.getOrCreateTerminal(cwd, terminalProfileId, location)
		const startDetached = (terminalInfo: Awaited<typeof terminalPromise>, log: DetachedCommandLog): void => {
			try {
				const process = terminalManager.runCommand(terminalInfo, terminalCommand, { reveal })
				log.attach(process)
				tracked?.attach(terminalInfo, process)
				void process.catch((error) => log.fail(error))
				process.detach()
			} catch (error) {
				log.fail(error)
				tracked?.fail()
			}
		}
		const acquisition = terminalPromise.then(
			(terminalInfo) => ({ type: "terminal" as const, terminalInfo }),
			(error: unknown) => ({ type: "error" as const, error }),
		)
		const finishDetachedAcquisition = (outcome: Awaited<typeof acquisition>, log: DetachedCommandLog): void => {
			if (outcome.type === "terminal") {
				startDetached(outcome.terminalInfo, log)
			} else {
				log.fail(outcome.error)
				tracked?.fail()
			}
		}
		const finishAbortedAcquisition = (outcome: Awaited<typeof acquisition>): void => {
			if (outcome.type === "terminal") {
				terminalManager.releaseTerminalReservation(outcome.terminalInfo)
			}
		}
		const firstOutcome = await Promise.race([
			acquisition,
			preStartControl.then((control) => ({ type: "control" as const, control })),
		])

		if (firstOutcome.type === "control") {
			if (firstOutcome.control === "abort") {
				// Acquisition is already in flight and may return a synchronously
				// reserved terminal after this tool result settles. Consume it so a
				// pre-start cancellation cannot leave that terminal permanently busy.
				void acquisition.then(finishAbortedAcquisition)
				throw abortedError()
			}

			const log = detachedLog
			if (!log) {
				throw new Error("Detached command log was not initialized")
			}
			void acquisition.then((outcome) => finishDetachedAcquisition(outcome, log))
			return formatDetachedResult(log.path, "", detachReason ?? "timeout", tracked?.id)
		}

		// Acquisition and a user action can resolve in the same microtask turn.
		// Re-check the invocation phase after the await so an already-queued
		// terminal outcome cannot overwrite a detach or abort that happened while
		// the promise continuation was pending.
		if (state.phase === "aborted") {
			finishAbortedAcquisition(firstOutcome)
			throw abortedError()
		}
		if (state.phase === "detached") {
			const log = detachedLog
			if (!log) {
				throw new Error("Detached command log was not initialized")
			}
			finishDetachedAcquisition(firstOutcome, log)
			return formatDetachedResult(log.path, "", detachReason ?? "timeout", tracked?.id)
		}
		if (firstOutcome.type === "error") {
			throw firstOutcome.error
		}

		state.phase = "started"
		const { terminalInfo } = firstOutcome

		const process = terminalManager.runCommand(terminalInfo, terminalCommand, { reveal })
		const outputLines: string[] = []
		let droppedLines = 0

		// Accumulate output lines to return the full output once the command completes.
		// The chat shows command output at completion, not incrementally.
		//
		// This is a second buffer on top of the process's own `fullOutput` (capped at
		// MAX_FULL_OUTPUT_SIZE — see VscodeTerminalProcess), so it needs its own cap:
		// a long-running command emitting many lines must not accumulate them here
		// without bound. Once the cap is hit, keep only the head and tail — matching
		// truncateCommandOutput's own head/tail strategy below — since build/test
		// failures usually appear at the end of output.
		const maxBufferedLines = MAX_UNRETRIEVED_LINES
		const bufferLine = (line: string): void => {
			if (outputLines.length < maxBufferedLines) {
				outputLines.push(line)
			} else {
				outputLines.shift()
				outputLines.push(line)
				droppedLines++
			}
		}
		process.on("line", bufferLine)

		try {
			applyAbort = () => {
				// A cancelled task must actually stop the running command, not just
				// stop observing it. VS Code has no API to kill a terminal's
				// foreground process, so send Ctrl+C (SIGINT) before detaching our
				// listeners; continue() alone would leave the command running in the
				// user's terminal after cancellation.
				try {
					terminalManager.sendInterrupt(terminalInfo)
				} catch (error) {
					Logger.warn(
						`[VscodeRunCommands] Failed to interrupt command on cancellation: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
				process.continue()
			}

			applyDetach = (reason) => {
				if (detachedLog !== undefined) {
					return
				}
				detachReason = reason
				detachedLog = createDetachedCommandLog(terminalCommand, outputLines)
				detachedLog.attach(process)
				tracked = track(detachedLog.path)
				tracked?.attach(terminalInfo, process)
				// detach() flushes any partial line (reaching both bufferLine and
				// the log) before resolving the awaited promise. After that the
				// partial output is final: stop buffering so the remaining
				// (log-only) output doesn't mutate outputLines while it's read.
				process.detach()
				process.removeListener("line", bufferLine)
			}

			// Wait for completion (or detach, which also resolves the promise)
			await process

			const bufferedOutput =
				droppedLines > 0
					? [...outputLines, `\n... (${droppedLines} earlier lines dropped) ...\n`].join("\n")
					: outputLines.join("\n")
			const truncated = digestOrTruncate(bufferedOutput.trim(), maxOutputChars)
			const note =
				truncated.length > 0
					? narrowTerminalNote(process.getCompletionDetails?.()?.terminalColumns, terminalInfo.location ?? "panel")
					: undefined
			const output = note ? `${truncated}\n${note}` : truncated

			if (abortSignal?.aborted) {
				throw abortedError(output)
			}

			if (detachedLog !== undefined) {
				return formatDetachedResult(detachedLog.path, output, detachReason ?? "timeout", tracked?.id)
			}

			const completionDetails = process.getCompletionDetails?.()

			// A terminal closed mid-command has no exit code and no reliable output —
			// whatever the command was doing (e.g. running a test suite) was interrupted,
			// so this must never look like success to the agent.
			if (completionDetails?.terminalClosed) {
				const result =
					output.length > 0
						? `[Terminal closed while the command was running; output may be incomplete]\n${output}`
						: "[Terminal closed while the command was running; no output was captured]"
				throw new CommandExitError(1, result)
			}

			if (completionDetails?.unobservedCommand) {
				const disposition = getUnobservedTerminalCommandDisposition(completionDetails.unobservedCommand)
				const lifecycle =
					disposition === "disposeBeforeNextTerminalAcquisition"
						? "The terminal remains open for now, but starting another foreground command will attempt to close it, stopping the command if it is still running."
						: "The terminal has been left open and will not be closed automatically."
				const result =
					output.length > 0
						? `[Command completion could not be observed; the command may still be running and must not be assumed to have succeeded. ${lifecycle}]\n${output}`
						: `[Command completion could not be observed; the command may still be running and must not be assumed to have succeeded. ${lifecycle}]`
				throw new CommandExitError(1, result)
			}

			// A command that stopped on a question for the keyboard never ran to
			// completion; it was interrupted. Say so, and say what to do instead,
			// before the exit code: Ctrl+C may leave it 0, or unset.
			if (completionDetails?.awaitingInput !== undefined) {
				const note =
					`[The command stopped and waited for keyboard input (its last line was "${completionDetails.awaitingInput.slice(0, 160)}"), ` +
					`which PlinyCode cannot type, so it was interrupted with Ctrl+C after ${INPUT_PROMPT_IDLE_TIMEOUT / 1000}s. ` +
					"It did not complete. Rerun it non-interactively: pass the answer as a flag (for example --yes, -y, --no-input, --force), " +
					"pipe the input to it, or set the value in an environment variable.]"
				const exitCode = completionDetails.exitCode
				throw new CommandExitError(
					typeof exitCode === "number" && exitCode !== 0 ? exitCode : 1,
					output.length > 0 ? `${note}\n${output}` : note,
				)
			}

			// Plumb the exit code from onDidEndTerminalShellExecution through to the tool
			// result. When shell integration reports a non-zero exit code, throw
			// CommandExitError so the SDK's shell tool wrapper marks the result as
			// `success: false` and includes the exit code in the error message —
			// matching the background (child_process) executor's behavior.
			// If no exit code was captured after an observed completion, return the
			// output as-is. Unobserved completion is handled explicitly above.
			const exitCode = completionDetails?.exitCode
			if (exitCode !== undefined && exitCode !== null && exitCode !== 0) {
				const result =
					output.length > 0
						? `[Command exited with code ${exitCode}]\n${output}`
						: `[Command exited with code ${exitCode}]`
				throw new CommandExitError(exitCode, result)
			}

			return output
		} finally {
			process.removeListener("line", bufferLine)
		}
	} finally {
		clearTimeout(autoProceedTimer)
		abortSignal?.removeEventListener("abort", onAbort)
		userMessageSignal?.removeEventListener("abort", onUserMessage)
		unregister?.()
	}
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * The shell selected by the user's terminal profile setting at one moment:
 * the profile ID for foreground terminal creation and the shell executable
 * it resolves to for background spawning and description building.
 */
interface ShellSnapshot {
	profileId: string
	shell: string
}

/** Resolves the shell the user's terminal profile setting selects right now. */
function takeShellSnapshot(): ShellSnapshot {
	// The setting is typed string, but guard empty values the same way the
	// settings handlers do (they skip persisting "" but older stores may hold one).
	const profileId = StateManager.get().getGlobalSettingsKey("defaultTerminalProfile") || "default"
	return { profileId, shell: getShellForProfile(profileId) }
}

/**
 * Creates the custom `run_commands` tool for the VSCode extension.
 *
 * This tool suppresses and replaces the SDK's built-in `run_commands` tool.
 * The terminal execution mode is captured when the session's tool set is
 * built; switching modes rebuilds the active SDK session so the tool timeout
 * and execution path follow it.
 *
 * The shell is snapshotted each time the runtime reads the tool description,
 * which happens when a model request is built. Tool calls produced by that
 * request execute with the same snapshot, so changing the terminal profile
 * while the model is generating does not change the shell under commands the
 * model has already planned: the new shell is named in the next request (the
 * one carrying these tool results) and used by the commands it produces.
 */
export function createVscodeRunCommandsTool(options: VscodeRunCommandsToolOptions): AgentTool {
	const state = { snapshot: takeShellSnapshot() }
	const terminalMode = (options.vscodeTerminalExecutionMode ?? "vscodeTerminal") === "vscodeTerminal"
	const notes = [
		terminalMode ? FOREGROUND_LONG_RUNNING_NOTE : undefined,
		!terminalMode && options.bashTimeoutMs
			? `A command still running after ${Math.round(options.bashTimeoutMs / 60_000)} minutes is stopped.`
			: undefined,
		options.processes ? BACKGROUND_ARGUMENT_NOTE : undefined,
	]
	const longRunningNote = notes.filter((note): note is string => note !== undefined).join(" ") || undefined
	const tool = createShellTool(createVscodeShellExecutor(options, state), {
		cwd: options.cwd,
		bashTimeoutMs: options.bashTimeoutMs,
		longRunningNote,
		shell: () => {
			state.snapshot = takeShellSnapshot()
			return state.snapshot.shell
		},
	})
	if (options.processes) {
		addBackgroundArgument(tool)
	}
	return tool
}

/**
 * Marks a tool call made with `background: true` on the context the engine
 * hands to the executor (it copies the context's own keys, symbols included).
 */
const RUN_IN_BACKGROUND = Symbol("plinycode.runCommandsInBackground")

type RunCommandsContext = AgentToolContext & { [RUN_IN_BACKGROUND]?: boolean }

/**
 * Adds the optional `background` argument to the engine's run_commands. The
 * tool is changed in place, because its description is a getter that must
 * keep being read for each model request.
 */
function addBackgroundArgument(tool: AgentTool): void {
	const schema = tool.inputSchema as { properties?: Record<string, unknown> }
	tool.inputSchema = {
		...tool.inputSchema,
		properties: {
			...(schema.properties ?? {}),
			background: {
				type: "boolean",
				description:
					"Start the commands as background processes and return at once with their ids, without waiting for them to finish.",
			},
		},
	}
	const execute = tool.execute.bind(tool)
	tool.execute = (input, context) => {
		if (input && typeof input === "object" && !Array.isArray(input) && "background" in input) {
			const { background, ...rest } = input as Record<string, unknown>
			if (background === true || background === "true") {
				const backgroundContext: RunCommandsContext = { ...context, [RUN_IN_BACKGROUND]: true }
				return execute(rest, backgroundContext)
			}
			return execute(rest, context)
		}
		return execute(input, context)
	}
}

/**
 * Starts a command as a child process the call does not wait for: its output
 * goes to a log file, and the ProcessRegistry can stop it by aborting it,
 * which kills the process tree.
 */
function startBackgroundProcess(
	command: ShellCommand,
	cwd: string,
	context: AgentToolContext,
	executor: ShellExecutor,
	tracking: ProcessTracking,
): string {
	const displayCommand = formatCommandForTerminal(command)
	const log = openCappedLogFile("background-process")
	log.tryWrite(`[Running command: ${displayCommand}]\n`)
	let sizeCapReached = false
	const controller = new AbortController()
	let settle!: () => void
	const settled = new Promise<void>((resolve) => {
		settle = resolve
	})

	const registered = tracking.registry.register({
		conversationId: tracking.conversationId,
		command: displayCommand,
		cwd,
		source: "child",
		logPath: log.path,
		kill: async () => {
			controller.abort(new Error("Stopped with process_kill"))
			await settled
		},
	})

	// The executor streams output through emitUpdate while the command runs,
	// and resolves with the same output once it ends; only the stream is logged.
	const childContext: AgentToolContext = {
		...context,
		signal: controller.signal,
		userMessageSignal: undefined,
		emitUpdate: (update) => {
			const chunk = (update as { chunk?: unknown } | undefined)?.chunk
			if (typeof chunk === "string" && chunk.length > 0 && !sizeCapReached && !log.tryWrite(chunk)) {
				sizeCapReached = true
			}
		},
	}
	const finish = (message: string, exitCode?: number): void => {
		log.end(sizeCapReached ? `\n${LOG_SIZE_CAP_MESSAGE}\n${message}` : `\n${message}`)
		tracking.registry.markExited(registered.id, exitCode)
	}
	void executor(command, cwd, childContext)
		.then(
			() => finish("[Command completed with exit code 0]", 0),
			(error: unknown) => {
				if (error instanceof CommandExitError) {
					finish(`[Command exited with code ${error.exitCode}]`, error.exitCode)
				} else if (controller.signal.aborted) {
					finish("[Command stopped]")
				} else {
					finish(`[Command failed: ${error instanceof Error ? error.message : String(error)}]`)
				}
			},
		)
		.finally(settle)

	return (
		`Started ${displayCommand} as process ${registered.id} (log: ${log.path}). ` +
		"Use process_output to read it and process_kill to stop it."
	)
}

function createVscodeShellExecutor(options: VscodeRunCommandsToolOptions, state: { snapshot: ShellSnapshot }): ShellExecutor {
	const { cwd, getTerminalManager } = options
	const executionMode = options.vscodeTerminalExecutionMode ?? "vscodeTerminal"

	// Lazy-init background executor — recreated when the snapshotted shell changes.
	let bgExecutor: ShellExecutor | undefined
	let bgExecutorShell: string | undefined

	// The executor for `background: true`: the same spawn, without the tool's timeout.
	let processExecutor: ShellExecutor | undefined
	let processExecutorShell: string | undefined

	// Lazy-init terminal manager reference
	let terminalManager: VscodeTerminalManager | undefined

	return async (command, commandCwd, context): Promise<string> => {
		// Execute with the shell named in the model request that produced this
		// tool call, not the setting's current value (see createVscodeRunCommandsTool).
		const { profileId, shell } = state.snapshot
		const processes: ProcessTracking | undefined = options.processes
			? { registry: options.processes, conversationId: processConversationId(context) }
			: undefined

		if (processes && (context as RunCommandsContext)[RUN_IN_BACKGROUND]) {
			Logger.log("[VscodeRunCommands] Starting a background process")
			if (!processExecutor || processExecutorShell !== shell) {
				processExecutorShell = shell
				processExecutor = createShellExecutor({ shell, env: spawnEnv(shell), timeoutMs: BACKGROUND_PROCESS_MAX_MS })
			}
			return startBackgroundProcess(command, commandCwd || cwd, context, processExecutor, processes)
		}

		Logger.log(`[VscodeRunCommands] Executing command in ${executionMode} mode`)

		if (executionMode === "backgroundExec") {
			// Background path — use SDK's createShellExecutor.
			// Recreate the executor if the shell has changed
			if (!bgExecutor || bgExecutorShell !== shell) {
				bgExecutorShell = shell
				bgExecutor = createShellExecutor({
					shell,
					// SHELL matches the shell we're spawning so child processes see the
					// correct value instead of the inherited parent's.
					env: spawnEnv(shell),
					// The tool's limit; the engine's own default would stop commands at 30 seconds.
					timeoutMs: options.bashTimeoutMs,
				})
				Logger.log(`[VscodeRunCommands] Background executor using shell: ${shell}`)
			}
			// Record execution outcomes so background mode is comparable with
			// foreground mode in the same task.terminal_execution event.
			try {
				const result = await bgExecutor(command, commandCwd || cwd, context)
				return result
			} catch (error) {
				throw error
			}
		}

		// Foreground path — use VscodeTerminalManager
		if (!terminalManager) {
			terminalManager = getTerminalManager()
		}
		return await executeForeground(
			command,
			commandCwd || cwd,
			terminalManager,
			MAX_COMMAND_OUTPUT_CHARS,
			context.signal,
			options.foregroundCommands,
			profileId,
			context.sessionId,
			context.userMessageSignal,
			processes,
		)
	}
}
