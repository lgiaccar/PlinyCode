/**
 * Heuristics for detecting a shell prompt at the end of terminal output.
 *
 * Used to decide that a command has probably finished when shell integration
 * markers are unavailable — e.g. the user ssh'd from the terminal, so commands
 * execute in a remote shell that emits no OSC 633 sequences. Ported from
 * VS Code's `detectsCommonPromptPattern` (src/vs/workbench/contrib/
 * terminalContrib/chatAgentTools/browser/executeStrategy/executeStrategy.ts),
 * which backs the basic/none execute strategies of its own run-in-terminal
 * tool.
 */

/**
 * Returns the last line of output. Trailing newlines are ignored (the prompt
 * is the cursor line), and carriage returns within the line are treated as
 * overwrites so only the final visible content is returned.
 */
export function getLastLine(output: string): string {
	const trimmed = output.replace(/[\r\n]+$/, "")
	const afterLastLf = trimmed.slice(trimmed.lastIndexOf("\n") + 1)
	return afterLastLf.slice(afterLastLf.lastIndexOf("\r") + 1)
}

/**
 * How confidently a line looks like a shell prompt awaiting input.
 *
 * - "strong": the line matches a shape specific enough (a path, a known REPL
 *   marker, bash/root's `$`/`#`, starship's `❯`) that a false positive is
 *   unlikely. Safe to trust after a single short idle period.
 * - "weak": the line merely ends in a generic prompt character (`>` or `%`)
 *   with no other structure — this also matches a still-running `ssh`/nested
 *   shell printing a bare `>` continuation prompt, an HTML/XML tag, or a
 *   progress meter. Only trust this after the full markerless quiet timeout,
 *   not the first short idle period.
 * - "none": does not look like a prompt at all.
 */
type ShellPromptStrength = "strong" | "weak" | "none"

/**
 * Classifies whether a line looks like a shell prompt awaiting input, and how
 * confidently. Callers deciding whether a markerless command has finished
 * should only act on "weak" after a long quiet period — see
 * MARKERLESS_MAX_QUIET_TIME in constants.ts — since a "weak" match returning
 * buffered output a little early for a genuinely idle prompt is far better
 * than mistaking a still-running command's `>`/`%`-terminated output for one.
 */
export function classifyShellPrompt(lastLine: string): ShellPromptStrength {
	const line = lastLine.trimEnd()
	if (!line) {
		return "none"
	}
	// PowerShell: "PS C:\path>"
	if (/PS\s+[A-Z]:\\.*>$/.test(line)) {
		return "strong"
	}
	// Command Prompt: "C:\path>"
	if (/^[A-Z]:\\.*>$/.test(line)) {
		return "strong"
	}
	// Python REPL: exactly ">>>" (whitespace already trimmed above).
	if (/^>>>$/.test(line)) {
		return "strong"
	}
	// bash "$" and root "#" are specific enough to trust immediately, as is
	// starship's "❯". zsh "%" and the generic fish/nested-shell ">" are common
	// false-positive shapes (progress meters, HTML tags, a `>` continuation
	// prompt in a hung remote shell), so they're classified as "weak" below.
	if (/[$#\u276f]$/.test(line)) {
		return "strong"
	}
	if (/[%>]$/.test(line)) {
		return "weak"
	}
	return "none"
}

/**
 * Shapes of a program asking the keyboard a question. Matched against the last
 * line of a command's output once it has been quiet for a while, so the odd
 * log line that happens to end in "?" only matters if nothing follows it.
 */
const INPUT_PROMPT_PATTERNS: readonly RegExp[] = [
	// "Overwrite? [y/N]", "Continue (yes/no)?", "Proceed [Y/n/a]:"
	/[[(]\s*(?:y(?:es)?|no?)\s*\/\s*(?:y(?:es)?|no?)(?:\s*\/\s*[a-z]+)*\s*[\])]\s*[:?]?\s*$/i,
	/\?\s*[[(][^\])]{1,24}[\])]\s*$/,
	// Credentials: "Password:", "Enter passphrase for key:", "Username for 'https://…':"
	/\b(?:password|passphrase|passcode|pin|otp|one-time (?:code|password)|verification code|access token|api key|username|user ?name|login|e-?mail)\b[^\n]{0,60}[:?]\s*$/i,
	// "Press any key to continue . . .", "Press Enter to exit"
	/\b(?:press|hit)\b[^\n]{0,30}\b(?:any key|enter|return|a key|space)\b/i,
	// "Are you sure you want to delete it?", "Do you want to continue?"
	/\b(?:are you sure|do you want|would you like|is (?:this|that) (?:ok|okay|correct)|continue|proceed|overwrite|replace|abort|retry|confirm)\b[^\n]{0,80}\?\s*$/i,
	// "Enter a value:", "Select an option:", "Choose your preset >"
	/\b(?:enter|type|input|choose|select|pick|specify|provide|what is|which)\b[^\n]{0,80}[:?>]\s*$/i,
	// "(default: main)", "[default=yes]"
	/[[(]default[^\])]{0,40}[\])]\s*[:?]?\s*$/i,
]

/**
 * Whether the last output line of a quiet command reads as a question waiting
 * for the keyboard. A shell prompt is not one (the command is over), nor is a
 * long line: real prompts are short. Callers act on this only after the
 * command has produced nothing for a while, see INPUT_PROMPT_IDLE_TIMEOUT.
 */
export function looksLikeInputPrompt(lastLine: string): boolean {
	const line = lastLine.replace(/\s+$/, "")
	if (!line || line.length > 200 || classifyShellPrompt(line) === "strong") {
		return false
	}
	return INPUT_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
}

/**
 * Whether a line looks like a shell prompt awaiting input, at any confidence.
 *
 * @deprecated Prefer {@link classifyShellPrompt} so callers can gate weak
 * matches on a longer quiet period. Kept for callers that don't yet
 * distinguish strength.
 */
export function looksLikeShellPrompt(lastLine: string): boolean {
	return classifyShellPrompt(lastLine) !== "none"
}
