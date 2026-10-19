import type { Controller } from "@core/controller"
import { ImprovePromptRequest } from "@shared/proto/cline/task"
import { describe, expect, it, vi } from "vitest"
import { improvePrompt } from "../improvePrompt"

describe("improvePrompt", () => {
	it("forwards the draft and mode and returns the rewrite", async () => {
		const improve = vi.fn(async () => ({ text: "Fix the login redirect." }))
		const controller = { improvePrompt: improve } as unknown as Controller

		const result = await improvePrompt(controller, ImprovePromptRequest.create({ text: "fix login", mode: "plan" }))

		expect(improve).toHaveBeenCalledWith("fix login", "plan")
		expect(result).toEqual({ text: "Fix the login redirect.", error: "" })
	})

	it("returns the failure reason and treats an unknown mode as act", async () => {
		const improve = vi.fn(async () => ({ error: "The model returned no text." }))
		const controller = { improvePrompt: improve } as unknown as Controller

		const result = await improvePrompt(controller, ImprovePromptRequest.create({ text: "fix login", mode: "" }))

		expect(improve).toHaveBeenCalledWith("fix login", "act")
		expect(result).toEqual({ text: "", error: "The model returned no text." })
	})
})
