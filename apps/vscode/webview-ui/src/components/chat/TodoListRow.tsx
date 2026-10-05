import type { ClineMessage } from "@shared/ExtensionMessage"
import type { TodoItem, TodoStatus } from "@shared/todo-list"
import { CircleCheckIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from "lucide-react"
import { cn } from "@/lib/utils"

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed"
}

/**
 * The list in a `task_progress` message. Current messages carry JSON
 * (`{ todos: [...] }`); conversations from before the task list was rebuilt
 * carry a markdown checklist, which is read line by line.
 */
function parseTodoListText(text: string | undefined): TodoItem[] {
	if (!text?.trim()) {
		return []
	}
	try {
		const parsed = JSON.parse(text)
		const todos: unknown = parsed?.todos
		if (Array.isArray(todos)) {
			return todos.filter(
				(item): item is TodoItem =>
					!!item && typeof item.content === "string" && item.content.length > 0 && isTodoStatus(item.status),
			)
		}
	} catch {
		// Not JSON: a legacy markdown checklist.
	}
	return text.split(/\r?\n/).flatMap((line): TodoItem[] => {
		const match = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/.exec(line)
		if (!match) {
			return []
		}
		return [{ content: match[2].trim(), status: match[1] === " " ? "pending" : "completed" }]
	})
}

const StatusIcon = ({ status }: { status: TodoStatus }) => {
	if (status === "completed") {
		return <CircleCheckIcon className="size-2 text-success shrink-0 mt-[3px]" />
	}
	if (status === "in_progress") {
		return <CircleDotIcon className="size-2 text-foreground shrink-0 mt-[3px]" />
	}
	return <CircleIcon className="size-2 text-description shrink-0 mt-[3px]" />
}

/** The agent's task list, as it stood after one `update_todo_list` call. */
const TodoListRow = ({ message }: { message: ClineMessage }) => {
	const todos = parseTodoListText(message.text)
	if (todos.length === 0) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}
	const done = todos.filter((item) => item.status === "completed").length

	return (
		<div className="py-1.5">
			<div className="flex items-center gap-2 text-description">
				<ListTodoIcon className="size-2 shrink-0" />
				<span>
					Tasks · {done} of {todos.length} done
				</span>
			</div>
			<ul className="mt-1.5 ml-0.5 pl-0 list-none flex flex-col gap-1">
				{todos.map((item, index) => (
					<li className="flex items-start gap-2" key={`${index}-${item.content}`}>
						<StatusIcon status={item.status} />
						<span
							className={cn("min-w-0 break-words", {
								"text-description line-through": item.status === "completed",
								"text-foreground font-medium": item.status === "in_progress",
								"text-foreground": item.status === "pending",
							})}>
							{item.content}
						</span>
					</li>
				))}
			</ul>
		</div>
	)
}

export default TodoListRow
