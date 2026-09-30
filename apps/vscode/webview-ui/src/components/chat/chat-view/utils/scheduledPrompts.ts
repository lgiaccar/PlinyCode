import type { ScheduledPrompt } from "../components/layout/ScheduledPrompts"

/** Whether a scheduled prompt belongs to the conversation on screen (undefined = the welcome screen). */
export function isScheduledForTask(prompt: ScheduledPrompt, taskId: string | undefined): boolean {
	return prompt.taskId === taskId
}

/**
 * Splits the schedule at `now` for the conversation on screen. Prompts due in
 * that conversation are returned in `due`; `rest` is the new schedule, where a
 * repeating prompt stays, moved one interval on, until its sends run out.
 * Prompts of other conversations are never due here: they wait, however
 * overdue, until their conversation is shown again.
 */
export function takeDueScheduledPrompts(
	prompts: readonly ScheduledPrompt[],
	now: number,
	taskId: string | undefined,
): { due: ScheduledPrompt[]; rest: ScheduledPrompt[] } {
	const due: ScheduledPrompt[] = []
	const rest: ScheduledPrompt[] = []
	for (const prompt of prompts) {
		if (prompt.scheduledAt > now || !isScheduledForTask(prompt, taskId)) {
			rest.push(prompt)
			continue
		}
		due.push(prompt)
		const remaining = (prompt.remaining ?? 1) - 1
		if (remaining < 1 || !prompt.intervalMs) {
			continue
		}
		let next = prompt.scheduledAt + prompt.intervalMs
		while (next <= now) {
			next += prompt.intervalMs
		}
		// A prompt sent from the welcome screen starts a new conversation;
		// its repeats belong to that one, whose id is not known yet.
		rest.push({ ...prompt, remaining, scheduledAt: next, ...(taskId === undefined ? { bindToNextTask: true } : {}) })
	}
	return { due, rest }
}

/** Binds repeats left by a prompt sent from the welcome screen to the conversation it started. */
export function bindScheduledPromptsToTask(prompts: readonly ScheduledPrompt[], taskId: string): ScheduledPrompt[] {
	if (!prompts.some((prompt) => prompt.bindToNextTask)) {
		return prompts as ScheduledPrompt[]
	}
	return prompts.map((prompt) => {
		if (!prompt.bindToNextTask) {
			return prompt
		}
		const { bindToNextTask: _, ...bound } = prompt
		return { ...bound, taskId }
	})
}
