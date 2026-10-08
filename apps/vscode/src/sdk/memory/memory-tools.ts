/**
 * `save_memory`: adds one entry to the repository's or the user's memory
 * (docs/memory.md).
 *
 * A dedicated tool rather than the editor, so that:
 * - it works in ask mode, which has no editor, and in plan mode;
 * - the entry lands in the right place by importance (memory-file.ts), and a
 *   duplicate is not added twice;
 * - a side question cannot call it (core's off-the-record guard names it).
 *
 * It follows the "Edit files" auto-approve toggle (sdk-tool-policies.ts): a
 * memory is sent with every later request, so a write prompted by injected
 * text would outlive the conversation.
 */

import type { AgentTool } from "@plinycode/shared"
import type { MemorySaveInput, MemoryScope, MemoryStore } from "./memory-store"

const SAVE_MEMORY_TOOL_NAME = "save_memory"

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Accepts what models send in practice: aliases, and importance as a word or a boolean. */
export function parseSaveMemoryInput(raw: unknown): MemorySaveInput {
	const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
	const memory = text(input.text) ?? text(input.memory) ?? text(input.content)
	if (!memory) {
		throw new Error(
			'Nothing to save. Send { "text": "<one line>", "scope": "repo" | "user", "importance": "high" | "normal" }.',
		)
	}
	const scopeValue = text(input.scope)?.toLowerCase()
	const scope: MemoryScope = scopeValue === "user" || scopeValue === "global" || scopeValue === "personal" ? "user" : "repo"
	const importanceValue = input.importance ?? input.important
	const importance =
		importanceValue === true || (typeof importanceValue === "string" && /^(high|important|critical)$/i.test(importanceValue))
			? "high"
			: "normal"
	return { scope, text: memory, importance, topic: text(input.topic), details: text(input.details) }
}

interface SaveMemoryToolDeps {
	store: MemoryStore
	/** The folder whose repository the memory belongs to: the session's cwd. */
	getCwd: () => string
}

export function createSaveMemoryTool(deps: SaveMemoryToolDeps): AgentTool {
	return {
		name: SAVE_MEMORY_TOOL_NAME,
		description:
			"Save a memory that later conversations will see in their system prompt. Use it for what a future conversation in " +
			"this repository would need and could not easily find out (a non-obvious convention, a gotcha, a decision and its " +
			"reason, a command that works), or when the user asks you to remember something. One line per memory. " +
			'scope "repo" (default) is shared by every clone of this repository; "user" is for the user\'s personal preferences ' +
			'across all repositories. importance "high" puts it at the top, which a small memory budget keeps; use it only when ' +
			"forgetting would cause real mistakes. For a longer explanation, give `details` and a `topic`: the details go in a " +
			"topic file that is read on demand, and the one-line memory points to it.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The memory, in one line." },
				scope: { type: "string", enum: ["repo", "user"], description: 'Where to save it. Default "repo".' },
				importance: { type: "string", enum: ["high", "normal"], description: 'Default "normal".' },
				topic: { type: "string", description: "Topic file name for `details`, e.g. build-quirks." },
				details: { type: "string", description: "Optional longer markdown, appended to the topic file." },
			},
			required: ["text"],
		},
		retryable: false,
		async execute(rawInput: unknown): Promise<string> {
			const input = parseSaveMemoryInput(rawInput)
			const result = await deps.store.save(deps.getCwd(), input)
			if (!result.inserted) {
				return `That memory is already in ${result.file}; nothing was added.`
			}
			const where = input.importance === "high" ? "at the top of Important" : "at the end of Notes"
			const topic = result.topicFile ? ` Details were appended to ${result.topicFile}.` : ""
			return `Saved to ${result.file}, ${where}. Later conversations will see it.${topic}`
		},
	}
}
