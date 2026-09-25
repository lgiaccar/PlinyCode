/**
 * Environment every agent-driven terminal gets on top of the user's own.
 *
 * Commands the model runs are never interactive, but the tools they call do
 * not know that: `git branch` or `git log` with more output than the terminal
 * is tall hand the output to a pager that then waits for a keypress the model
 * cannot send, and a git remote that needs credentials prompts on the terminal
 * for them. Both looked like the agent hanging for minutes. Pagers are told to
 * write straight through and git is told to fail instead of prompting.
 */
export const AGENT_TERMINAL_ENV: Readonly<Record<string, string>> = {
	CLINE_ACTIVE: "true",
	GIT_PAGER: "cat",
	PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
}
