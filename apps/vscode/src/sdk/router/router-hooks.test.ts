import type { AgentAfterToolContext, AgentHooks, AgentRunLifecycleContext, AgentRunResult } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import { composeHooks } from "./router-hooks"

const toolContext = {
	snapshot: { agentId: "a", iteration: 1 },
	tool: { name: "run_commands" },
	toolCall: { type: "tool-call", toolCallId: "c", toolName: "run_commands", input: {} },
	input: {},
	result: { output: "ok" },
	startedAt: new Date(0),
	endedAt: new Date(0),
	durationMs: 0,
} as unknown as AgentAfterToolContext

const runContext = {
	snapshot: { agentId: "a", iteration: 1 },
	result: { status: "completed" } as AgentRunResult,
} as AgentRunLifecycleContext & { result: AgentRunResult }

describe("composeHooks", () => {
	it("keeps the base hooks it does not touch", async () => {
		const beforeRun = vi.fn()
		const composed = composeHooks({ beforeRun }, { afterTool: () => undefined })
		expect(composed.beforeRun).toBe(beforeRun)
	})

	it("calls the base afterTool first and joins both contexts", async () => {
		const order: string[] = []
		const base: AgentHooks = {
			afterTool: async () => {
				order.push("base")
				return { appendContext: "from hook script" }
			},
		}
		const composed = composeHooks(base, {
			afterTool: () => {
				order.push("router")
				return { appendContext: "from router" }
			},
		})
		const result = await composed.afterTool?.(toolContext)
		expect(order).toEqual(["base", "router"])
		expect(result?.appendContext).toBe("from hook script\n\nfrom router")
	})

	it("lets the base hook's stop decision stand and passes the router's note through alone", async () => {
		const stopping = composeHooks(
			{ afterTool: async () => ({ stop: true, reason: "policy" }) },
			{ afterTool: () => ({ appendContext: "note" }) },
		)
		expect(await stopping.afterTool?.(toolContext)).toEqual({ stop: true, reason: "policy", appendContext: "note" })

		const alone = composeHooks(undefined, { afterTool: () => ({ appendContext: "note" }) })
		expect(await alone.afterTool?.(toolContext)).toEqual({ appendContext: "note" })

		const silent = composeHooks({ afterTool: async () => ({ appendContext: "base" }) }, { afterTool: () => undefined })
		expect(await silent.afterTool?.(toolContext)).toEqual({ appendContext: "base" })
	})

	it("runs the router's afterRun even when the base hook throws", async () => {
		const routerAfterRun = vi.fn()
		const composed = composeHooks(
			{
				afterRun: async () => {
					throw new Error("hook script failed")
				},
			},
			{ afterRun: routerAfterRun },
		)
		await expect(composed.afterRun?.(runContext)).rejects.toThrow("hook script failed")
		expect(routerAfterRun).toHaveBeenCalledTimes(1)
	})
})
