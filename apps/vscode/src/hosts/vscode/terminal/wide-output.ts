import * as path from "path"
import * as vscode from "vscode"
import { ConptyWrapJoiner } from "@/hosts/vscode/terminal/conptyWrapJoiner"
import { Logger } from "@/shared/services/Logger"
import { getShell } from "@/utils/shell"

/**
 * Wide output: commands in PowerShell terminals run through a small wrapper
 * so their output is not laid out to the terminal's width.
 *
 * Programs format to the terminal's width before PlinyCode reads a byte, and
 * a terminal panel docked beside the editor is often 30–60 columns wide:
 * PowerShell drops table columns and breaks error messages, and native tools
 * that ask the console for its width do the same. The wrapper keeps the
 * command in the user's terminal (same profile, environment and visibility)
 * but sends its output through the PowerShell pipeline:
 *
 * - native programs write to a pipe rather than the console, so they do not
 *   measure it;
 * - PowerShell objects are formatted by `Out-String -Width 400`;
 * - error, warning and verbose records are written as one line each instead
 *   of through the console-width error view.
 *
 * The long lines that result are still wrapped by ConPTY on screen, but that
 * wrap is undone by `ConptyWrapJoiner`; the program's own layout could not be.
 */

/** Carries the wrapper's source into PlinyCode's terminals, so it never appears in the terminal. */
export const WIDE_OUTPUT_ENV_VAR = "PLINYCODE_RUN"

const FUNCTION_NAME = "plinyrun"
const READY_MARKER = "plinycode-wide-output-ready"
const PREPARE_TIMEOUT_MS = 5000

/**
 * The wrapper, defined as a function in each PowerShell terminal and
 * dot-sourced, so the command runs in the prompt's scope: variables, imported
 * modules and `Set-Location` stay as if it had been typed.
 *
 * - `$?` after the command's last statement is kept and, when false, handed
 *   back through `$PSCmdlet.WriteError` with errors silenced, so shell
 *   integration still reports the command as failed. (`exit` would close the
 *   terminal.)
 * - `COLUMNS=200` is set for tools that cannot measure a pipe (Python's
 *   shutil, rich, pytest), as for Background Exec, and `PYTHONUNBUFFERED`
 *   keeps Python's output live now that it writes to a pipe.
 *
 * No backticks (PowerShell's escape character) and no `${`, so it can sit in
 * a template literal unescaped.
 */
export const WIDE_OUTPUT_FUNCTION = `[CmdletBinding()]
param([Parameter(Position = 0)][string]$PlinyCommand)
$__plinyEnv = @{ COLUMNS = $env:COLUMNS; PYTHONUNBUFFERED = $env:PYTHONUNBUFFERED }
$env:COLUMNS = '200'
$env:PYTHONUNBUFFERED = '1'
$global:LASTEXITCODE = 0
$__plinyOk = $false
try {
	. ([scriptblock]::Create($PlinyCommand + [char]10 + '$__plinyOk = $?')) *>&1 | ForEach-Object {
		if ($_ -is [System.Management.Automation.ErrorRecord]) {
			if ($_.FullyQualifiedErrorId -like 'NativeCommandError*') { $_.ToString() }
			else {
				$__plinyName = $_.InvocationInfo.MyCommand.Name
				if ($__plinyName) { "$__plinyName : $_" } else { "$_" }
				if ($_.InvocationInfo.ScriptName) { "At $($_.InvocationInfo.ScriptName):$($_.InvocationInfo.ScriptLineNumber) char:$($_.InvocationInfo.OffsetInLine)" }
				"    + CategoryInfo          : $($_.CategoryInfo)"
				"    + FullyQualifiedErrorId : $($_.FullyQualifiedErrorId)"
			}
		}
		elseif ($_ -is [System.Management.Automation.WarningRecord]) { "WARNING: $($_.Message)" }
		elseif ($_ -is [System.Management.Automation.VerboseRecord]) { "VERBOSE: $($_.Message)" }
		elseif ($_ -is [System.Management.Automation.DebugRecord]) { "DEBUG: $($_.Message)" }
		elseif ($_ -is [System.Management.Automation.InformationRecord]) { "$_" }
		else { $_ }
	} | Out-String -Stream -Width 400
} catch {
	if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { "$_" }
	$__plinyOk = $false
} finally {
	$env:COLUMNS = $__plinyEnv.COLUMNS
	$env:PYTHONUNBUFFERED = $__plinyEnv.PYTHONUNBUFFERED
}
if (-not $__plinyOk) {
	$__plinyEap = $ErrorActionPreference
	$ErrorActionPreference = 'SilentlyContinue'
	$PSCmdlet.WriteError([System.Management.Automation.ErrorRecord]::new([System.Exception]::new('The command failed.'), 'PlinyCodeCommandFailed', 'NotSpecified', $null))
	$ErrorActionPreference = $__plinyEap
	if ($Error.Count) { $Error.RemoveAt(0) }
}
`

/**
 * Run once per terminal, before its first wrapped command. Constrained
 * Language mode (AppLocker, WDAC) blocks the wrapper's method calls, so the
 * function is only defined, and the marker only printed, in full language
 * mode; anywhere else commands run as typed.
 */
export const WIDE_OUTPUT_PREPARE_COMMAND =
	`if ($env:${WIDE_OUTPUT_ENV_VAR} -and $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') ` +
	`{ Set-Item function:${FUNCTION_NAME} $env:${WIDE_OUTPUT_ENV_VAR}; '${READY_MARKER.slice(0, 15)}' + '${READY_MARKER.slice(15)}' }`

/** Whether commands should run through the wrapper (`plinycode.terminal.wideOutput`). */
export function isWideOutputEnabled(): boolean {
	return vscode.workspace.getConfiguration("plinycode.terminal").get<boolean>("wideOutput") !== false
}

const POWERSHELL_EXECUTABLE = /^(powershell|pwsh)(\.exe)?$/i

function isPowerShellPath(shellPath: string | undefined): boolean {
	return POWERSHELL_EXECUTABLE.test(path.win32.basename(shellPath ?? getShell()))
}

/**
 * The wrapper's source for a new terminal's environment, when its shell
 * (`undefined` for the default profile) is PowerShell.
 */
export function wideOutputEnv(shellPath: string | undefined): Record<string, string> {
	return isPowerShellPath(shellPath) ? { [WIDE_OUTPUT_ENV_VAR]: WIDE_OUTPUT_FUNCTION } : {}
}

/**
 * Whether the terminal runs PowerShell and was created with the wrapper's
 * source in its environment. The shell VS Code detects wins, since it follows
 * a sub-shell (bash started inside PowerShell); until it is known, the
 * terminal's shell path decides.
 */
export function canUseWideOutput(terminal: vscode.Terminal): boolean {
	const options = terminal.creationOptions as vscode.TerminalOptions | undefined
	if (!options?.env?.[WIDE_OUTPUT_ENV_VAR]) {
		return false
	}
	const detected = terminal.state?.shell
	if (detected !== undefined) {
		return detected === "pwsh"
	}
	return isPowerShellPath(options.shellPath)
}

/** Each terminal's preparation, run once: whether the wrapper is defined in it. */
const prepared = new WeakMap<vscode.Terminal, Promise<boolean>>()

/** Defines the wrapper in the terminal if it can be, once; resolves whether it was. */
export function prepareWideOutput(terminal: vscode.Terminal): Promise<boolean> {
	let ready = prepared.get(terminal)
	if (!ready) {
		ready = runPrepareCommand(terminal)
		prepared.set(terminal, ready)
	}
	return ready
}

async function runPrepareCommand(terminal: vscode.Terminal): Promise<boolean> {
	const shellIntegration = terminal.shellIntegration
	if (!shellIntegration?.executeCommand) {
		return false
	}
	let output = ""
	let timeout: NodeJS.Timeout | undefined
	try {
		const execution = shellIntegration.executeCommand(WIDE_OUTPUT_PREPARE_COMMAND)
		const drain = (async () => {
			for await (const chunk of execution.read()) {
				output += chunk
			}
		})()
		const timedOut = await Promise.race([
			drain.then(() => false),
			new Promise<boolean>((resolve) => {
				timeout = setTimeout(() => resolve(true), PREPARE_TIMEOUT_MS)
			}),
		])
		if (timedOut) {
			Logger.warn(
				`[WideOutput] The terminal did not finish preparing within ${PREPARE_TIMEOUT_MS}ms; running commands as typed`,
			)
			return false
		}
	} catch (error) {
		Logger.warn(`[WideOutput] Could not prepare the terminal; running commands as typed: ${error}`)
		return false
	} finally {
		if (timeout) {
			clearTimeout(timeout)
		}
	}
	// The echoed command line holds the marker in two halves, so only the
	// printed one matches, even when ConPTY wrapped the echo.
	const joiner = new ConptyWrapJoiner()
	const ready = (joiner.push(output) + joiner.flush()).includes(READY_MARKER)
	if (!ready) {
		Logger.log("[WideOutput] PowerShell is not in full language mode; running commands as typed")
	}
	return ready
}

/** PowerShell treats the typographic single quotes as quotes too. */
const SINGLE_QUOTES = /['‘’‚‛]/g

/** The command as the terminal runs it through the wrapper. */
export function wideOutputCommand(command: string): string {
	return `. ${FUNCTION_NAME} '${command.replace(SINGLE_QUOTES, "$&$&")}'`
}
