/**
 * What the extension and the webview both need to know about the CI watcher
 * (docs/devops-mcp.md): its tool name and how its reports are recognised once
 * they are messages in a conversation.
 */

export const WATCH_CI_TOOL_NAME = "watch_ci"

/**
 * First characters of every report the watcher sends into a conversation. A
 * report is delivered as a prompt, so it is stored and replayed like a user
 * message; this marker is how the chat tells it apart from one the user typed.
 */
export const CI_WATCH_MARKER = "[CI WATCHER]"

/** First words of the `watch_ci` result when a watch was started (not cancelled). */
export const WATCH_CI_STARTED_PREFIX = "Watching CI"

export function isCiWatchReport(text: string | undefined): boolean {
	return !!text && text.trimStart().startsWith(CI_WATCH_MARKER)
}

/** A watcher report without its marker, for display. */
export function ciWatchReportBody(text: string): string {
	return text.trimStart().slice(CI_WATCH_MARKER.length).trimStart()
}
