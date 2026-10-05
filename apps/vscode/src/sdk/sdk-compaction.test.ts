import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const createContextCompactionPrepareTurn = vi.fn()
const createSessionCompactionState = vi.fn((input: unknown) => ({ version: 1, input }))
vi.mock("@plinycode/core", async (importOriginal) => ({
	createContextCompactionPrepareTurn: (...args: unknown[]) => createContextCompactionPrepareTurn(...args),
	createSessionCompactionState: (input: unknown) => createSessionCompactionState(input),
	// The real filter (the stub re-exports it from the engine's source).
	dropOffTheRecordTurns: (await importOriginal<typeof import("@plinycode/core")>()).dropOffTheRecordTurns,
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

let compactSessionMessages: typeof import("./sdk-compaction").compactSessionMessages

const baseConfig = {
	providerConfig: { providerId: "anthropic", modelId: "claude" },
	providerId: "anthropic",
	modelId: "claude",
	knownModels: { claude: { id: "claude", maxInputTokens: 200_000 } },
	compaction: undefined,
	logger: undefined,
} as unknown as Parameters<typeof compactSessionMessages>[0]["config"]

describe("compactSessionMessages", () => {
	beforeAll(async () => {
		;({ compactSessionMessages } = await import("./sdk-compaction"))
	})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns compacted=false without invoking the SDK when there are no messages", async () => {
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages: [] })

		expect(result).toEqual({ compacted: false, messages: [] })
		expect(createContextCompactionPrepareTurn).not.toHaveBeenCalled()
	})

	it("builds a manual-mode prepareTurn and force-enables compaction", async () => {
		const compact = vi
			.fn()
			.mockResolvedValue({ messages: [{ role: "user", content: "summary" }], systemPrompt: "rewritten system" })
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)

		const messages = [
			{ role: "user" as const, content: "1" },
			{ role: "assistant" as const, content: "2" },
		]
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages })

		// Manual mode + enabled compaction + session id.
		expect(createContextCompactionPrepareTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "anthropic",
				modelId: "claude",
				compaction: expect.objectContaining({ enabled: true }),
				sessionId: "s1",
			}),
			{ mode: "manual" },
		)
		expect(compact).toHaveBeenCalledOnce()
		expect(createSessionCompactionState).toHaveBeenCalledWith({
			sourceMessages: messages,
			compactedMessages: [{ role: "user", content: "summary" }],
			conversationId: "s1",
			systemPrompt: "rewritten system",
		})
		expect(result).toEqual({
			compacted: true,
			messages: [{ role: "user", content: "summary" }],
			compactionState: { version: 1, input: expect.anything() },
		})
	})

	it("leaves side questions out of what it compacts and of the saved state's source", async () => {
		const compact = vi.fn().mockResolvedValue({ messages: [{ role: "user", content: "summary" }] })
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)

		const messages = [
			{ role: "user" as const, content: "build the parser" },
			{ role: "assistant" as const, content: "done" },
			{ role: "user" as const, content: "side: what is a lexer?", metadata: { offTheRecord: true } },
			{ role: "assistant" as const, content: "it tokenizes" },
			{ role: "user" as const, content: "add tests" },
			{ role: "assistant" as const, content: "added" },
		]
		await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages })

		const onRecord = [messages[0], messages[1], messages[4], messages[5]]
		expect(compact).toHaveBeenCalledWith(expect.objectContaining({ messages: onRecord, apiMessages: onRecord }))
		expect(createSessionCompactionState).toHaveBeenCalledWith(expect.objectContaining({ sourceMessages: onRecord }))
	})

	it("preserves context-only model limits for the shared resolver", async () => {
		const compact = vi.fn().mockResolvedValue({ messages: [{ role: "user", content: "summary" }] })
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)
		const contextOnlyConfig = {
			...baseConfig,
			knownModels: { claude: { id: "claude", contextWindow: 400_000 } },
		} as unknown as Parameters<typeof compactSessionMessages>[0]["config"]

		await compactSessionMessages({
			config: contextOnlyConfig,
			sessionId: "s-context-only",
			messages: [{ role: "user", content: "long context" }],
		})

		expect(compact).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({
					info: { id: "claude", contextWindow: 400_000 },
				}),
			}),
		)
	})

	it("returns compacted=false when prepareTurn is unavailable", async () => {
		createContextCompactionPrepareTurn.mockReturnValueOnce(undefined)

		const messages = [{ role: "user" as const, content: "1" }]
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages })

		expect(result).toEqual({ compacted: false, messages })
	})

	it("returns compacted=false when the strategy declines (returns undefined)", async () => {
		const compact = vi.fn().mockResolvedValue(undefined)
		createContextCompactionPrepareTurn.mockReturnValueOnce(compact)

		const messages = [{ role: "user" as const, content: "1" }]
		const result = await compactSessionMessages({ config: baseConfig, sessionId: "s1", messages })

		expect(result).toEqual({ compacted: false, messages })
	})
})
