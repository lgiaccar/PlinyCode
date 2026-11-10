import { describe, expect, it } from "vitest"
import { collectDeliveryEvidence } from "./delivery-evidence"

describe("delivery evidence", () => {
	it("ignores prose and unmatched results, preserving actual failures", () => {
		const snapshot = collectDeliveryEvidence([
			{ role: "assistant", content: [{ type: "text", text: "All tests passed; published!" }] },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "c", name: "run_commands", input: { commands: ["bun run test"] } }],
			},
			{
				role: "user",
				createdAt: 123,
				content: [
					{ type: "tool_result", tool_use_id: "c", is_error: true, content: "Tests failed" },
					{ type: "tool_result", tool_use_id: "unknown", content: "passed" },
				],
			},
		])
		expect(snapshot.evidence).toHaveLength(1)
		expect(snapshot.evidence[0]).toMatchObject({ category: "checks", failed: true, output: "Tests failed", at: 123 })
	})
	it("keeps output bounded and does not label successful tool calls as successful delivery", () => {
		const snapshot = collectDeliveryEvidence([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "r", name: "run_commands", input: { command: "gh release view v1" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "r", content: "x".repeat(15000) }] },
		])
		expect(snapshot.evidence[0]).toMatchObject({ category: "release", failed: false, truncated: true })
		expect(snapshot.evidence[0]?.output).toHaveLength(12000)
	})
})
