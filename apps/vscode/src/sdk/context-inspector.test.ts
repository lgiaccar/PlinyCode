import type { AgentModelRequest } from "@plinycode/shared"
import { expect, it } from "vitest"
import { captureContextRequest, inspectContextRequests } from "./context-inspector"

function request(text: string): AgentModelRequest {
	return {
		systemPrompt: "System\nRules body\nMemory body",
		messages: [{ id: "m", role: "user", createdAt: 1, content: [{ type: "text", text }] }],
		tools: [],
		options: { metadata: { contextSources: { rulesText: "Rules body", memoryText: "Memory body" } } },
	}
}
it("keeps immutable request-time source text and only the latest three requests", () => {
	const input = request("Original message")
	captureContextRequest("immutable", "router", 1, input)
	input.systemPrompt = "Changed later"
	input.messages[0].content = [{ type: "text", text: "Changed later" }]
	const first = inspectContextRequests("immutable").requests[0]
	expect(first.sections.find((section) => section.label === "Rules")?.content).toBe("Rules body")
	expect(first.sections.some((section) => section.content.includes("Original message"))).toBe(true)
	for (let i = 2; i <= 5; i++) captureContextRequest("immutable", "router", i, request(`Request ${i}`))
	expect(inspectContextRequests("immutable")).toMatchObject({ omittedRequests: 2, requests: [{ id: 3 }, { id: 4 }, { id: 5 }] })
})
it("bounds previews and clearly records omitted binary media without altering the request", () => {
	const input = request("x".repeat(50000))
	input.messages[0].content.push({ type: "image", image: "data:image/png;base64,SECRET_BINARY" })
	captureContextRequest("bounded", "model", 1, input)
	const snapshot = inspectContextRequests("bounded").requests[0]
	expect(snapshot.sections.some((section) => section.partial)).toBe(true)
	expect(JSON.stringify(snapshot)).not.toContain("SECRET_BINARY")
	expect(snapshot.sections.some((section) => section.content.includes("binary payload is not retained"))).toBe(true)
	expect(snapshot.sections.reduce((total, section) => total + section.content.length, 0)).toBeLessThanOrEqual(180000)
	expect(input.messages[0].content[0]).toMatchObject({ text: "x".repeat(50000) })
})
it("evicts old conversations and does not claim unmatched source metadata was included", () => {
	for (let i = 0; i < 9; i++) captureContextRequest(`eviction-${i}`, "model", i, request("hello"))
	expect(inspectContextRequests("eviction-0").requests).toEqual([])
	const input = request("hello")
	input.systemPrompt = "Different system prompt"
	captureContextRequest("unmatched", "model", 1, input)
	expect(inspectContextRequests("unmatched").requests[0].notices.join(" ")).toContain("not found verbatim")
})
