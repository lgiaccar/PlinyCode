import { describe, expect, it } from "vitest"
import {
	apiReqInfoPayload,
	askQuestionPayload,
	bugReportPayload,
	clineSayToolPayload,
	compactionPayload,
	conditionalRulesPayload,
	hookStatusPayload,
	parsePayloadText,
	parseSayPayload,
	planModeResponsePayload,
	subagentStatusPayload,
	subagentUsagePayload,
	useMcpServerPayload,
	useSubagentsPayload,
} from "./chat-payloads"

const statusItem = {
	index: 1,
	prompt: "Explore",
	status: "running",
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	totalCost: 0,
	contextTokens: 0,
	contextWindow: 0,
	contextUsagePercentage: 0,
}

// Each payload type with a valid value and a value of the wrong shape.
const cases = [
	{
		payload: clineSayToolPayload,
		valid: { tool: "readFile", path: "src/a.ts", startLineNumbers: [1, 4] },
		wrongShape: { tool: "editedExistingFile", content: 42 },
	},
	{ payload: apiReqInfoPayload, valid: { request: "hi", cost: 0.01, tokensIn: 5 }, wrongShape: { cost: "free" } },
	{ payload: subagentUsagePayload, valid: { source: "advisor", tokensIn: 1, cost: 0 }, wrongShape: { tokensIn: [] } },
	{
		payload: useMcpServerPayload,
		valid: { type: "use_mcp_tool", serverName: "github", toolName: "list", arguments: "{}" },
		wrongShape: { type: "use_mcp_tool", serverName: { name: "github" } },
	},
	{ payload: askQuestionPayload, valid: { question: "Which?", options: ["a", "b"] }, wrongShape: { options: "a" } },
	{ payload: planModeResponsePayload, valid: { response: "Plan", options: [] }, wrongShape: { response: 1 } },
	{ payload: useSubagentsPayload, valid: { prompts: ["one", "two"] }, wrongShape: { prompts: "one" } },
	{
		payload: subagentStatusPayload,
		valid: { status: "running", items: [statusItem] },
		wrongShape: { status: "running", items: [{ ...statusItem, prompt: { text: "x" } }] },
	},
	{ payload: compactionPayload, valid: { status: "completed", mode: "auto" }, wrongShape: { mode: "auto" } },
	{
		payload: hookStatusPayload,
		valid: { hookName: "PreToolUse", status: "completed", exitCode: 0 },
		wrongShape: { hookName: ["PreToolUse"], status: "completed" },
	},
	{ payload: conditionalRulesPayload, valid: { rules: [{ name: "ts.md" }] }, wrongShape: { rules: [{}] } },
	{ payload: bugReportPayload, valid: { title: "Crash" }, wrongShape: { title: { text: "Crash" } } },
]

describe("chat payload parsing", () => {
	for (const { payload, valid, wrongShape } of cases) {
		describe(payload.name, () => {
			it("returns the value of a valid payload", () => {
				expect(parseSayPayload({ text: JSON.stringify(valid) }, payload)).toEqual({ ok: true, value: valid })
			})

			it("reports truncated JSON instead of throwing", () => {
				const text = JSON.stringify(valid).slice(0, -3)
				const result = parseSayPayload({ text }, payload)
				expect(result.ok).toBe(false)
				expect(!result.ok && result.error).toContain("not valid JSON")
			})

			it("reports a payload of the wrong shape", () => {
				const result = parseSayPayload({ text: JSON.stringify(wrongShape) }, payload)
				expect(result.ok).toBe(false)
				expect(!result.ok && result.error).toMatch(new RegExp(`^${payload.name}: payload`))
			})

			it("reports a root that is not an object", () => {
				for (const text of ["null", "[]", "42", '"text"']) {
					expect(parseSayPayload({ text }, payload).ok).toBe(false)
				}
			})
		})
	}

	it("reads empty text as an empty object, as the rows always did", () => {
		expect(parsePayloadText(undefined, clineSayToolPayload)).toEqual({ ok: true, value: {} })
		expect(parsePayloadText("", apiReqInfoPayload)).toEqual({ ok: true, value: {} })
	})

	it("allows null for optional fields", () => {
		expect(parsePayloadText('{"cost":null,"cancelReason":null}', apiReqInfoPayload).ok).toBe(true)
	})

	it("names the field that has the wrong type", () => {
		const result = parsePayloadText('{"tool":"readFile","path":7}', clineSayToolPayload)
		expect(result).toEqual({ ok: false, error: "tool: payload.path should be a string, got a number" })
	})
})
