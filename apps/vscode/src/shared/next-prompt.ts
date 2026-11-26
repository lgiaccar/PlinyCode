import type { ClineMessage, TurnPhase } from "./ExtensionMessage"
/** A normal clean text response ends in awaiting_followup; a completion tool ends in completed. */
export function nextPromptCompletion(messages: readonly ClineMessage[], phase: TurnPhase | undefined): ClineMessage | undefined {
	if (phase !== "completed" && phase !== "awaiting_followup") return undefined
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type === "ask") {
			if (message.ask === "resume_completed_task") continue
			return undefined
		}
		if (message.say === "completion_result" || message.say === "plan_completion_result")
			return message.partial ? undefined : message
		if (["task", "user_feedback", "text", "tool", "command", "command_output", "error"].includes(message.say ?? ""))
			return undefined
	}
	return undefined
}
