import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import { buildClassifierRequest, extractJsonObjects, parseClassification, runClassifier } from "./router-classifier"
import { defaultRules } from "./router-rules"
import type { RouterRequestFeatures, RouterRules } from "./router-types"

function features(overrides: Partial<RouterRequestFeatures> = {}): RouterRequestFeatures {
	return {
		estimatedTokens: 12_000,
		mode: "act",
		prompt: "fix the failing test in router.ts",
		hasImages: false,
		isSubAgent: false,
		callIndex: 1,
		...overrides,
	}
}

function rules(overrides: Partial<RouterRules["classifier"]> = {}): RouterRules {
	const base = defaultRules("smart")
	return { ...base, classifier: { ...base.classifier, ...overrides } }
}

function request(
	texts: Array<[role: "user" | "assistant", text: string, metadata?: Record<string, unknown>]>,
	signal?: AbortSignal,
): AgentModelRequest {
	return {
		messages: texts.map(([role, text, metadata], index) => ({
			id: `m${index}`,
			role,
			content: [{ type: "text", text }],
			createdAt: index,
			...(metadata ? { metadata } : {}),
		})),
		tools: [],
		...(signal ? { signal } : {}),
	}
}

function replying(text: string): AgentModel {
	return {
		async *stream() {
			yield { type: "text-delta", text } satisfies AgentModelEvent
			yield { type: "finish", reason: "stop" } satisfies AgentModelEvent
		},
	}
}

describe("parseClassification", () => {
	it("reads a plain JSON verdict", () => {
		expect(parseClassification('{"tier": "code", "think": false}')).toEqual({ tier: "code", think: false })
	})

	it("finds the verdict inside surrounding prose and a think block", () => {
		const text = '<think>they want a plan {"tier":"quick"}</think>Sure: {"tier": "Reason", "think": true}'
		expect(parseClassification(text)).toEqual({ tier: "reason", think: true })
	})

	it("treats a missing or non-boolean think as false", () => {
		expect(parseClassification('{"tier":"huge"}')).toEqual({ tier: "huge", think: false })
		expect(parseClassification('{"tier":"huge","think":"yes"}')).toEqual({ tier: "huge", think: false })
	})

	it("rejects unknown tiers and non-JSON", () => {
		expect(parseClassification('{"tier":"galaxy-brain","think":true}')).toBeUndefined()
		expect(parseClassification("code, and think hard")).toBeUndefined()
	})

	it("reads a verdict from a fenced block, with nested braces, or quoted booleans", () => {
		expect(parseClassification('Here you go:\n```json\n{"tier": "code", "think": "true"}\n```')).toEqual({
			tier: "code",
			think: true,
		})
		expect(parseClassification('{"analysis": {"kind": "bug"}, "tier": "reason", "think": true}')).toEqual({
			tier: "reason",
			think: true,
		})
		expect(parseClassification('{"tier": "quick", "think": "false", "note": "a } in a string"}')).toEqual({
			tier: "quick",
			think: false,
		})
	})

	it("still finds a verdict inside a think block the model never closed", () => {
		expect(parseClassification('<think>The user wants an edit, so {"tier": "code", "think": false} is right. Now I')).toEqual(
			{ tier: "code", think: false },
		)
	})

	it("reads the verdict from an object list", () => {
		expect(extractJsonObjects('a {"x": 1} b {"y": {"z": 2}} c')).toEqual([{ x: 1 }, { y: { z: 2 } }])
	})
})

describe("buildClassifierRequest", () => {
	it("sends a short tool-free request with reasoning off and a JSON-only reply", () => {
		const built = buildClassifierRequest(request([["user", "hello"]]), features(), rules(), new AbortController().signal)
		expect(built.tools).toEqual([])
		expect(built.options).toMatchObject({ thinking: false, responseFormat: "json" })
		expect(built.messages).toHaveLength(1)
	})

	it("includes a digest of earlier turns and the rules-file guidance", () => {
		const built = buildClassifierRequest(
			request([
				["user", "we are migrating the auth layer"],
				["assistant", "I read the middleware"],
				["user", "now fix the failing test in router.ts"],
			]),
			features(),
			{ ...rules(), guidance: "Prefer the coder for tests." },
			new AbortController().signal,
		)
		const prompt = (built.messages[0].content[0] as { text: string }).text
		expect(prompt).toContain("[user] we are migrating the auth layer")
		expect(prompt).toContain("[assistant] I read the middleware")
		expect(prompt).toContain("Latest request:\nfix the failing test in router.ts")
		expect(built.systemPrompt).toContain("Prefer the coder for tests.")
	})

	it("leaves reminders, hook context and compaction notices out of the digest", () => {
		const built = buildClassifierRequest(
			request([
				["user", '<user_input mode="act">add the missing test</user_input>'],
				["assistant", "I'll add it now."],
				[
					"user",
					"[SYSTEM] Your last message said what you would do next, but you did not call a tool.",
					{ displayRole: "system", userRunSpan: 0 },
				],
				[
					"user",
					'<hook_context source="PostToolUse">the command failed</hook_context>',
					{ displayRole: "system", userRunSpan: 0 },
				],
				[
					"user",
					"Context summary:\n\nthe goal was to fix the build",
					{ kind: "compaction_summary", displayRole: "system" },
				],
				["user", "now run it"],
			]),
			features(),
			rules(),
			new AbortController().signal,
		)
		const prompt = (built.messages[0].content[0] as { text: string }).text
		expect(prompt).toContain("[user] add the missing test")
		expect(prompt).toContain("[assistant] I'll add it now.")
		expect(prompt).not.toContain("[SYSTEM]")
		expect(prompt).not.toContain("hook_context")
		expect(prompt).not.toContain("Context summary")
		expect(prompt).not.toContain("<user_input")
	})

	it("strips the editor state and mode notice from the digest lines", () => {
		const built = buildClassifierRequest(
			request([
				[
					"user",
					'<user_input mode="act"><mode_notice>The user switched from plan mode to act mode.</mode_notice>execute the plan\n<editor_state>\nOpen tabs:\n- .github/skills/code-sanitization/SKILL.md\n</editor_state></user_input>',
				],
				["user", "go on"],
			]),
			features(),
			rules(),
			new AbortController().signal,
		)
		const prompt = (built.messages[0].content[0] as { text: string }).text
		expect(prompt).toContain("[user] execute the plan")
		expect(prompt).not.toContain("code-sanitization")
		expect(prompt).not.toContain("mode_notice")
	})

	it("offers quick, code and reason, spells out the chores, and still parses a huge reply", () => {
		const built = buildClassifierRequest(request([["user", "x"]]), features(), rules(), new AbortController().signal)
		expect(built.systemPrompt).toContain('{"tier": "quick" | "code" | "reason", "think": true | false}')
		expect(built.systemPrompt).not.toContain('"huge"')
		expect(built.systemPrompt).toContain("pull request")
		expect(built.systemPrompt).toContain("[CI WATCHER]")
		expect(built.systemPrompt).toContain("never pick a tier because the context is large")
		expect(parseClassification('{"tier":"huge","think":false}')).toEqual({ tier: "huge", think: false })
	})

	it("truncates the latest prompt to the configured length", () => {
		const built = buildClassifierRequest(
			request([["user", "x"]]),
			features({ prompt: "a".repeat(500) }),
			rules({ maxPromptChars: 50 }),
			new AbortController().signal,
		)
		const prompt = (built.messages[0].content[0] as { text: string }).text
		expect(prompt.endsWith(`\n${"a".repeat(50)}`)).toBe(true)
	})
})

describe("runClassifier", () => {
	it("returns the verdict from the model's reply", async () => {
		const result = await runClassifier({
			model: replying('{"tier":"reason","think":true}'),
			request: request([["user", "design the cache"]]),
			features: features(),
			rules: rules(),
		})
		expect(result).toEqual({ classification: { tier: "reason", think: true } })
	})

	it("reports an unusable reply instead of guessing", async () => {
		const result = await runClassifier({
			model: replying("I think this is a coding task."),
			request: request([["user", "x"]]),
			features: features(),
			rules: rules(),
		})
		expect(result.classification).toBeUndefined()
		expect(result.error).toContain("unusable reply")
		expect(result.raw).toBe("I think this is a coding task.")
	})

	it("asks for the JSON first and leaves room for a verbose model", () => {
		const built = buildClassifierRequest(request([["user", "x"]]), features(), rules(), new AbortController().signal)
		expect(built.systemPrompt).toContain("Output one JSON object first")
		expect(built.options).toMatchObject({ maxTokens: 512 })
	})

	it("reports a failed call", async () => {
		const model: AgentModel = {
			async *stream() {
				yield { type: "finish", reason: "error", error: "503 no healthy upstream" } satisfies AgentModelEvent
			},
		}
		const result = await runClassifier({ model, request: request([["user", "x"]]), features: features(), rules: rules() })
		expect(result).toEqual({ error: "503 no healthy upstream" })
	})

	it("gives up after the timeout and aborts the request", async () => {
		let seenSignal: AbortSignal | undefined
		const hanging: AgentModel = {
			async *stream(req) {
				seenSignal = req.signal
				await new Promise((resolve) => setTimeout(resolve, 5_000))
				yield { type: "text-delta", text: '{"tier":"code"}' } satisfies AgentModelEvent
			},
		}
		const result = await runClassifier({
			model: hanging,
			request: request([["user", "x"]]),
			features: features(),
			rules: rules({ timeoutMs: 20 }),
		})
		expect(result.error).toContain("timed out")
		expect(seenSignal?.aborted).toBe(true)
	})

	it("aborts the classifier when the turn is cancelled", async () => {
		const turn = new AbortController()
		const abortSeen = vi.fn()
		const model: AgentModel = {
			async *stream(req) {
				req.signal?.addEventListener("abort", abortSeen)
				turn.abort()
				yield { type: "finish", reason: "aborted" } satisfies AgentModelEvent
			},
		}
		await runClassifier({ model, request: request([["user", "x"]], turn.signal), features: features(), rules: rules() })
		expect(abortSeen).toHaveBeenCalled()
	})
})
