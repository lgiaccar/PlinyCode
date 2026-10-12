/** Text helpers for putting CI output in front of a model: the watcher's reports and the CI board's triage. */

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what starts the sequence
const ANSI_STYLE = /\u001b\[[0-9;]*m/g

/** Colour codes mean nothing to a model and eat into any budget. */
export const stripAnsi = (text: string) => text.replace(ANSI_STYLE, "")

/**
 * A report is sent like a message the user typed, so the engine unwraps these
 * elements from it and the extension expands `@` mentions in it; a log that
 * prints `<user_input>` would swallow the rest of the report, and one that
 * prints `actions/checkout@<sha>` would pull in that commit's diff. A
 * zero-width space keeps both literal.
 */
export const defang = (text: string) =>
	text.replace(/<(\/?)(user_input|user_command|mode_notice|hook_context)/g, "<​$1$2").replace(/@(?=[\w"/-])/g, "@​")

/** Keeps a log from closing the Markdown fence it is shown in. */
export const unfence = (text: string) => text.replace(/```/g, "``​`")

/** The end of `text` that fits in `budget` characters, cut at a line start. */
export function tailWithin(text: string, budget: number): string {
	if (text.length <= budget) {
		return text
	}
	const cut = text.slice(text.length - budget)
	const newline = cut.indexOf("\n")
	return `…\n${newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut}`
}
