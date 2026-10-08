import type { CoreSessionConfig } from "@plinycode/core"
import type { AgentModel, AgentModelRequest } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import { formatLastModelRequest, installLastRequestCapture } from "./last-model-request"

const silent: AgentModel = {
	async *stream() {
		yield { type: "finish", reason: "stop" }
	},
}

function request(text: string): AgentModelRequest {
	return {
		systemPrompt: "You are PlinyCode.",
		messages: [{ id: "m1", role: "user", content: [{ type: "text", text }], createdAt: 0 }],
		tools: [{ name: "read_files", description: "Read files", inputSchema: { type: "object" } }],
		signal: new AbortController().signal,
	}
}

async function send(config: CoreSessionConfig, parentAgentId: string | undefined, text: string) {
	const factory = config.agentModelFactory
	if (!factory) {
		throw new Error("no factory installed")
	}
	const model = factory({
		config: { modelId: "pliny/auto-free", ...(parentAgentId ? { parentAgentId } : {}) } as never,
		createDefault: () => silent,
	})
	for await (const _event of await model.stream(request(text))) {
		// drain
	}
}

describe("installLastRequestCapture", () => {
	it("keeps the last root request of the session, as sent", async () => {
		const config = installLastRequestCapture({ sessionId: "s1" } as CoreSessionConfig, () => 0)

		await send(config, undefined, "first")
		await send(config, undefined, "second")
		await send(config, "parent", "a sub-agent's request")

		const shown = JSON.parse(formatLastModelRequest("s1") ?? "{}")
		expect(shown).toMatchObject({
			sessionId: "s1",
			modelId: "pliny/auto-free",
			sentAt: "1970-01-01T00:00:00.000Z",
			systemPrompt: "You are PlinyCode.",
			tools: [{ name: "read_files" }],
		})
		expect(shown.messages[0].content[0].text).toBe("second")
		expect(shown).not.toHaveProperty("signal")
	})

	it("reads the session id when the request is sent, not when the config is built", async () => {
		const config = installLastRequestCapture({} as CoreSessionConfig)
		config.sessionId = "assigned-later"

		await send(config, undefined, "hello")

		expect(formatLastModelRequest("assigned-later")).toContain('"hello"')
		expect(formatLastModelRequest("never-ran")).toBeUndefined()
	})
})
