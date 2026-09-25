/**
 * Extra system-prompt instructions for the free self-hosted models.
 *
 * The routed model appends this to each request it sends to a self-hosted
 * candidate — never to a paid one, which does not need it — so a mid-turn
 * model switch and a sub-agent both get it. It names, in plain terms, the ways
 * those models end a run too early (see `unfinished-turn-guard.ts`) and what
 * to do instead.
 */

export const ROUTER_MODEL_ADDENDUM = `
# How your turn ends

- Your turn ends the moment you reply without a tool call, and nothing runs for you afterwards. Only reply without a tool call when the task is complete, you are blocked, or you need an answer from the user.
- Never write "I'll check back at HH:MM", "stand by", "message me later" or "nothing to do but wait": you cannot come back. To wait for a running job, call the \`wait\` tool (up to 10 minutes per call), then read its log or run a status command, and repeat until it finishes or you have a concrete blocker. If the total wait would exceed about 30 minutes, ask the user whether to keep polling.
- When a command fails, fix the problem and rerun it before ending your turn. Report a failure only when you are blocked, and then ask the user how to proceed.
- Never announce a step ("Let me check the log:") without making the tool call in the same reply.
- Never ask permission for something the user already asked you to do. If they asked you to run it, run it.
- Before your final reply, reread the user's request and confirm every action it asked for was actually performed, not just prepared.
`.trim()

/** The system prompt with the addendum appended once. */
export function withRouterAddendum(systemPrompt: string | undefined): string {
	const base = systemPrompt?.trimEnd() ?? ""
	if (base.includes(ROUTER_MODEL_ADDENDUM)) {
		return base
	}
	return base ? `${base}\n\n${ROUTER_MODEL_ADDENDUM}` : ROUTER_MODEL_ADDENDUM
}
