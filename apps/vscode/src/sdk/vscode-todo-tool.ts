/**
 * `update_todo_list`: lets the agent keep a task list the user can see.
 *
 * A long run on a small model drifts: it finishes step two of five, gets
 * absorbed in a detail, and ends its turn as if the request were done. Writing
 * the steps down, and having to mark each one, keeps the remaining work in
 * front of the model, and shows the user where the run is.
 *
 * The tool keeps no state. The model sends the whole list every time, so the
 * current list is always in its own last call, and the chat shows each update
 * as a row (see the translator's `task_progress` handling).
 */

import type { AgentTool } from "@plinycode/shared"
import type { TodoItem, TodoStatus } from "@shared/todo-list"

export const TODO_TOOL_NAME = "update_todo_list"

const MAX_TODO_ITEMS = 30
const MAX_TODO_CONTENT_CHARS = 300

const STATUS_ALIASES: Record<string, TodoStatus> = {
	pending: "pending",
	todo: "pending",
	open: "pending",
	not_started: "pending",
	in_progress: "in_progress",
	inprogress: "in_progress",
	active: "in_progress",
	doing: "in_progress",
	started: "in_progress",
	completed: "completed",
	complete: "completed",
	done: "completed",
	finished: "completed",
}

function normalizeStatus(value: unknown): TodoStatus {
	if (typeof value !== "string") {
		return "pending"
	}
	return (
		STATUS_ALIASES[
			value
				.trim()
				.toLowerCase()
				.replace(/[\s-]+/g, "_")
		] ?? "pending"
	)
}

/** A markdown checklist line (`- [x] done`, `2. [ ] next`) or a bare line of text. */
function parseChecklistLine(line: string): TodoItem | undefined {
	const match = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[([^\]]?)\])?\s*(.*)$/.exec(line)
	const content = match?.[2]?.trim() ?? ""
	if (!content) {
		return undefined
	}
	const box = match?.[1]
	const status: TodoStatus = box === undefined || box.trim() === "" ? "pending" : /^x$/i.test(box) ? "completed" : "in_progress"
	return { content, status }
}

function normalizeItem(item: unknown): TodoItem | undefined {
	if (typeof item === "string") {
		return parseChecklistLine(item)
	}
	if (!item || typeof item !== "object") {
		return undefined
	}
	const record = item as Record<string, unknown>
	const content = [record.content, record.task, record.text, record.title, record.description].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	)
	if (!content) {
		return undefined
	}
	const status =
		record.status === undefined && (record.done === true || record.completed === true)
			? "completed"
			: normalizeStatus(record.status)
	return { content: content.trim(), status }
}

/**
 * Reads a task list out of whatever the model sent. The schema asks for
 * `{ todos: [{ content, status }] }`, but smaller models also send a markdown
 * checklist as one string, bare strings for items, or other names for the
 * same fields; rejecting those costs a turn and teaches nothing.
 */
export function normalizeTodoList(raw: unknown): TodoItem[] {
	let value = raw
	if (typeof value === "string") {
		try {
			value = JSON.parse(value)
		} catch {
			// Not JSON: a checklist written as text, handled below.
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>
		value = record.todos ?? record.items ?? record.tasks ?? record.list
		if (typeof value === "string") {
			try {
				value = JSON.parse(value)
			} catch {
				// A checklist written as text.
			}
		}
	}
	const entries: unknown[] = typeof value === "string" ? value.split(/\r?\n/) : Array.isArray(value) ? value : []
	return entries
		.map(normalizeItem)
		.filter((item): item is TodoItem => item !== undefined)
		.slice(0, MAX_TODO_ITEMS)
		.map((item) => ({ ...item, content: item.content.slice(0, MAX_TODO_CONTENT_CHARS) }))
}

/** What the model reads back: where the list stands and what comes next. */
function describeTodoList(todos: TodoItem[]): string {
	const done = todos.filter((item) => item.status === "completed").length
	if (done === todos.length) {
		return `Todo list updated: all ${todos.length} tasks are done.`
	}
	const active = todos.filter((item) => item.status === "in_progress")
	const parts = [`Todo list updated: ${done} of ${todos.length} done.`]
	if (active.length === 0) {
		const next = todos.find((item) => item.status === "pending")
		parts.push(`Next: ${next?.content}. Mark it in_progress when you start it.`)
	} else {
		parts.push(`In progress: ${active[0].content}.`)
		if (active.length > 1) {
			parts.push("Keep one task in progress at a time.")
		}
	}
	return parts.join(" ")
}

export function createTodoTool(): AgentTool {
	return {
		name: TODO_TOOL_NAME,
		description:
			"Keep a task list for work that takes three or more steps, and update it as you go. The user sees the list. " +
			"Send the whole list every time; each task has `content` and a `status` of pending, in_progress or completed. " +
			"Mark a task in_progress when you start it, one at a time, and completed as soon as it is finished, before " +
			"moving on. Add tasks you discover along the way. Do not end your turn while tasks are pending or in progress " +
			"unless you are blocked, and then say what blocks you. Skip this tool for a single-step request or a question.",
		inputSchema: {
			type: "object",
			properties: {
				todos: {
					type: "array",
					description: "The whole task list, in the order the work will be done.",
					items: {
						type: "object",
						properties: {
							content: { type: "string", description: "What the task is, in a few words." },
							status: { type: "string", enum: ["pending", "in_progress", "completed"] },
						},
						required: ["content", "status"],
					},
				},
			},
			required: ["todos"],
		},
		// Nothing to approve and nothing that can fail in transit.
		retryable: false,
		async execute(rawInput: unknown): Promise<string> {
			const todos = normalizeTodoList(rawInput)
			if (todos.length === 0) {
				throw new Error(
					'No tasks found. Send { "todos": [{ "content": "…", "status": "pending" | "in_progress" | "completed" }] } with the whole list.',
				)
			}
			return describeTodoList(todos)
		},
	}
}
