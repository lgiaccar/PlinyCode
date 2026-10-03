import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { executePlanPrompt, findPlanRootFile, isLatestPlanResult } from "./planFiles"

let ts = 1000

function say(sayType: ClineMessage["say"], text = ""): ClineMessage {
	return { ts: ts++, type: "say", say: sayType, text }
}

function write(path: string, tool: "newFileCreated" | "editedExistingFile" = "newFileCreated"): ClineMessage {
	return say("tool", JSON.stringify({ tool, path, content: "# x" }))
}

describe("findPlanRootFile", () => {
	it("prefers PLAN.md over sub-files written before it", () => {
		const plan = say("plan_completion_result", "Plan written")
		const messages = [say("task", "plan it"), write("plans/auth/01-api.md"), write("plans/auth/PLAN.md"), plan]

		expect(findPlanRootFile(messages, plan.ts)).toBe("plans/auth/PLAN.md")
	})

	it("falls back to the first markdown file written", () => {
		const plan = say("plan_completion_result")
		const messages = [say("task"), write("docs/design.md"), write("docs/steps.md"), plan]

		expect(findPlanRootFile(messages, plan.ts)).toBe("docs/design.md")
	})

	it("keeps the root across follow-up turns that only edit a sub-file", () => {
		const first = say("plan_completion_result")
		const second = say("plan_completion_result")
		const messages = [
			say("task"),
			write("plans/x/PLAN.md"),
			write("plans/x/01-a.md"),
			first,
			say("user_feedback", "tweak step 1"),
			write("plans/x/01-a.md", "editedExistingFile"),
			second,
		]

		expect(findPlanRootFile(messages, second.ts)).toBe("plans/x/PLAN.md")
	})

	it("ignores files written before the previous act-mode result", () => {
		const plan = say("plan_completion_result")
		const messages = [say("task"), write("plans/old/PLAN.md"), say("completion_result", "done"), say("user_feedback"), plan]

		expect(findPlanRootFile(messages, plan.ts)).toBeUndefined()
	})

	it("ignores non-markdown writes, other tools and malformed rows, and normalizes separators", () => {
		const plan = say("plan_completion_result")
		const messages = [
			say("task"),
			write("src/app.ts"),
			say("tool", JSON.stringify({ tool: "readFile", path: "README.md" })),
			say("tool", "{not json"),
			write("plans\\win\\PLAN.md"),
			plan,
		]

		expect(findPlanRootFile(messages, plan.ts)).toBe("plans/win/PLAN.md")
	})

	it("returns undefined when the plan wrote no file", () => {
		const plan = say("plan_completion_result", "Which database do you use?")

		expect(findPlanRootFile([say("task"), plan], plan.ts)).toBeUndefined()
		expect(findPlanRootFile([say("task")], 42)).toBeUndefined()
	})
})

describe("isLatestPlanResult", () => {
	it("is true when only bookkeeping rows follow the plan", () => {
		const plan = say("plan_completion_result")
		const messages = [say("task"), plan, say("api_req_started", "{}")]

		expect(isLatestPlanResult(messages, plan.ts)).toBe(true)
	})

	it("is false once the user replied or another result followed", () => {
		const plan = say("plan_completion_result")

		expect(isLatestPlanResult([plan, say("user_feedback", "hm")], plan.ts)).toBe(false)
		expect(isLatestPlanResult([plan, say("completion_result")], plan.ts)).toBe(false)
		expect(isLatestPlanResult([plan, say("plan_completion_result")], plan.ts)).toBe(false)
		expect(isLatestPlanResult([], plan.ts)).toBe(false)
	})
})

describe("executePlanPrompt", () => {
	it("names the root plan file", () => {
		expect(executePlanPrompt("plans/x/PLAN.md")).toBe("execute the plan in plans/x/PLAN.md")
	})
})
