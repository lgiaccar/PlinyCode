import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import TodoListRow from "./TodoListRow"

const message = (text: string): ClineMessage => ({ ts: 1, type: "say", say: "task_progress", text })

describe("TodoListRow", () => {
	it("shows the count and every task", () => {
		render(
			<TodoListRow
				message={message(
					JSON.stringify({
						todos: [
							{ content: "Read the router", status: "completed" },
							{ content: "Add the route", status: "in_progress" },
							{ content: "Run the tests", status: "pending" },
						],
					}),
				)}
			/>,
		)

		expect(screen.getByText("Tasks · 1 of 3 done")).toBeTruthy()
		expect(screen.getByText("Read the router").className).toContain("line-through")
		expect(screen.getByText("Add the route").className).toContain("font-medium")
		expect(screen.getByText("Run the tests")).toBeTruthy()
	})

	it("drops malformed entries", () => {
		render(
			<TodoListRow
				message={message(
					JSON.stringify({
						todos: [
							{ content: "Kept", status: "completed" },
							{ content: "Bad status", status: "nope" },
							{ status: "pending" },
						],
					}),
				)}
			/>,
		)

		expect(screen.getByText("Tasks · 1 of 1 done")).toBeTruthy()
		expect(screen.queryByText("Bad status")).toBeNull()
	})

	it("reads a markdown checklist from an old conversation", () => {
		render(<TodoListRow message={message("- [x] Done thing\n- [ ] Open thing\nnot a task")} />)

		expect(screen.getByText("Tasks · 1 of 2 done")).toBeTruthy()
		expect(screen.getByText("Done thing").className).toContain("line-through")
		expect(screen.getByText("Open thing")).toBeTruthy()
		expect(screen.queryByText("not a task")).toBeNull()
	})

	it("renders only a spacer when there is no list", () => {
		const { container } = render(<TodoListRow message={message("")} />)

		expect(container.querySelector("ul")).toBeNull()
		expect(container.querySelector("[aria-hidden]")).not.toBeNull()
	})
})
