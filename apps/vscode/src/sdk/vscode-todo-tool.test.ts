import type { AgentToolContext } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import { createTodoTool, normalizeTodoList } from "./vscode-todo-tool"

const ctx = { agentId: "agent-1", conversationId: "conv-1", iteration: 1 } as AgentToolContext

describe("normalizeTodoList", () => {
	it("reads the list the schema asks for", () => {
		expect(
			normalizeTodoList({
				todos: [
					{ content: "Read the router", status: "completed" },
					{ content: "Add the route", status: "in_progress" },
					{ content: "Run the tests", status: "pending" },
				],
			}),
		).toEqual([
			{ content: "Read the router", status: "completed" },
			{ content: "Add the route", status: "in_progress" },
			{ content: "Run the tests", status: "pending" },
		])
	})

	it("reads a markdown checklist sent as one string", () => {
		expect(
			normalizeTodoList({ todos: "- [x] Read the router\n- [-] Add the route\n- [ ] Run the tests\n\n3. Ship" }),
		).toEqual([
			{ content: "Read the router", status: "completed" },
			{ content: "Add the route", status: "in_progress" },
			{ content: "Run the tests", status: "pending" },
			{ content: "Ship", status: "pending" },
		])
	})

	it("accepts other names for the fields and for the statuses", () => {
		expect(
			normalizeTodoList({
				tasks: [{ task: "A", status: "Done" }, { title: "B", status: "in-progress" }, { text: "C", done: true }, "D"],
			}),
		).toEqual([
			{ content: "A", status: "completed" },
			{ content: "B", status: "in_progress" },
			{ content: "C", status: "completed" },
			{ content: "D", status: "pending" },
		])
	})

	it("reads arguments that arrive as a JSON string", () => {
		expect(normalizeTodoList(JSON.stringify({ todos: [{ content: "A", status: "pending" }] }))).toEqual([
			{ content: "A", status: "pending" },
		])
	})

	it("drops entries with no text and returns nothing for input that is not a list", () => {
		expect(normalizeTodoList({ todos: [{ status: "pending" }, "  ", null] })).toEqual([])
		expect(normalizeTodoList(undefined)).toEqual([])
		expect(normalizeTodoList({ todos: 3 })).toEqual([])
	})
})

describe("update_todo_list tool", () => {
	const run = (todos: unknown) => createTodoTool().execute({ todos }, ctx)

	it("reports progress and the task in progress", async () => {
		await expect(
			run([
				{ content: "Read the router", status: "completed" },
				{ content: "Add the route", status: "in_progress" },
				{ content: "Run the tests", status: "pending" },
			]),
		).resolves.toBe("Todo list updated: 1 of 3 done. In progress: Add the route.")
	})

	it("names the next task when none is in progress", async () => {
		await expect(
			run([
				{ content: "Read the router", status: "completed" },
				{ content: "Run the tests", status: "pending" },
			]),
		).resolves.toBe("Todo list updated: 1 of 2 done. Next: Run the tests. Mark it in_progress when you start it.")
	})

	it("says so when more than one task is in progress, and when all are done", async () => {
		await expect(
			run([
				{ content: "A", status: "in_progress" },
				{ content: "B", status: "in_progress" },
			]),
		).resolves.toBe("Todo list updated: 0 of 2 done. In progress: A. Keep one task in progress at a time.")
		await expect(run([{ content: "A", status: "completed" }])).resolves.toBe("Todo list updated: all 1 tasks are done.")
	})

	it("rejects a call with no tasks, saying what to send", async () => {
		await expect(run([])).rejects.toThrow("No tasks found.")
	})
})
