export type TodoStatus = "pending" | "in_progress" | "completed"

/** One entry of the agent's task list, kept with the `update_todo_list` tool. */
export interface TodoItem {
	content: string
	status: TodoStatus
}

/** Text payload of a `say: "task_progress"` message: the whole list after an update. */
export interface TodoListMessage {
	todos: TodoItem[]
}
