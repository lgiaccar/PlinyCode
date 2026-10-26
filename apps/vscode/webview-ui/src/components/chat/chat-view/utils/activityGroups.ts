import { isCiWatchReport } from "@shared/ciWatch"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { isUserTurnStart } from "./messageUtils"

export type ChatListItem = ClineMessage | ClineMessage[]

export type ActivityGroup = ClineMessage[] & {
	_isActivityGroup: true
	items: ChatListItem[]
}

export function isActivityGroup(item: ChatListItem): item is ActivityGroup {
	return Array.isArray(item) && (item as ActivityGroup)._isActivityGroup === true
}

function isPrompt(item: ChatListItem): boolean {
	// CI watcher reports start a separate agent response, but are not user turns.
	return (
		!Array.isArray(item) &&
		(isUserTurnStart(item) || (item.type === "say" && item.say === "user_feedback" && isCiWatchReport(item.text)))
	)
}

function isCompletion(item: ChatListItem): boolean {
	if (Array.isArray(item)) return false
	return (
		(item.type === "say" && (item.say === "completion_result" || item.say === "plan_completion_result")) ||
		(item.type === "ask" && (item.ask === "completion_result" || item.ask === "plan_mode_respond"))
	)
}

function mustStayVisible(item: ChatListItem): boolean {
	if (Array.isArray(item)) return false
	return (
		(item.type === "say" &&
			(["error", "diff_error", "clineignore_error", "memory_proposal", "hook_status"].includes(item.say ?? "") ||
				(item.say === "command" && item.commandCompleted !== true))) ||
		(item.type === "ask" && ["mistake_limit_reached", "tool"].includes(item.ask ?? ""))
	)
}

/** Keep one answer per prompt visible, with the preceding process rows available on demand. */
export function groupActivityRows(rows: ChatListItem[]): ChatListItem[] {
	const result: ChatListItem[] = []
	let turnStart = 0

	const appendTurn = (start: number, end: number) => {
		const turn = rows.slice(start, end)
		let finalAnswerIndex = -1
		for (let i = turn.length - 1; i >= 0; i--) {
			if (isCompletion(turn[i])) {
				finalAnswerIndex = i
				break
			}
		}
		if (finalAnswerIndex === -1) {
			const tail = turn.at(-1)
			if (tail && !Array.isArray(tail) && tail.type === "say" && tail.say === "text") {
				finalAnswerIndex = turn.length - 1
			}
		}
		let firstAnswerIndex = finalAnswerIndex
		// A final response may arrive as several adjacent text messages, not one row.
		const finalAnswer = turn[finalAnswerIndex]
		if (finalAnswer && !Array.isArray(finalAnswer) && finalAnswer.say === "text") {
			while (firstAnswerIndex > 0) {
				const previous = turn[firstAnswerIndex - 1]
				if (Array.isArray(previous) || previous.type !== "say" || previous.say !== "text") break
				firstAnswerIndex--
			}
		}

		let pending: ChatListItem[] = []
		const flush = () => {
			if (pending.length === 0) return
			const group = pending.flatMap((item) => (Array.isArray(item) ? item : [item])) as ActivityGroup
			group._isActivityGroup = true
			group.items = pending
			result.push(group)
			pending = []
		}

		for (let i = 0; i < turn.length; i++) {
			const item = turn[i]
			const isPendingQuestion = i === turn.length - 1 && !Array.isArray(item) && item.type === "ask"
			if (
				isPrompt(item) ||
				(i >= firstAnswerIndex && i <= finalAnswerIndex) ||
				isPendingQuestion ||
				mustStayVisible(item)
			) {
				flush()
				result.push(item)
			} else {
				pending.push(item)
			}
		}
		flush()
	}

	for (let i = 1; i < rows.length; i++) {
		if (isPrompt(rows[i])) {
			appendTurn(turnStart, i)
			turnStart = i
		}
	}
	appendTurn(turnStart, rows.length)
	return result
}
