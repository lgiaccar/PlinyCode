import { describe, expect, it } from "vitest"
import { sdkToolToClineSayTool } from "./tool-mapping"

// Unmapped tools render as an invisible row, which would leave an approval
// prompt for save_memory with nothing above its buttons.
describe("sdkToolToClineSayTool — memory tools", () => {
	it("shows what save_memory saves and where", () => {
		expect(sdkToolToClineSayTool("save_memory", { text: "Use bun", scope: "user" })).toEqual({
			tool: "saveMemory",
			path: "user",
			content: "Use bun",
		})
		expect(sdkToolToClineSayTool("save_memory", JSON.stringify({ text: "x" })).path).toBe("repo")
	})

	it("shows the query and the conversation read", () => {
		expect(sdkToolToClineSayTool("search_conversations", { query: "pager" })).toEqual({
			tool: "searchConversations",
			path: "pager",
		})
		expect(sdkToolToClineSayTool("read_conversation", { session_id: "s1" })).toEqual({
			tool: "readConversation",
			path: "s1",
		})
	})
})
