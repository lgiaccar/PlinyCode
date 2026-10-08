// Distillation: a free utility model reads a finished conversation and
// proposes memories worth keeping (docs/memory.md). Nothing here writes: the
// proposals go to the user as a chat row (memory-coordinator.ts), and only
// the ones they keep are saved.

import { offTheRecordMessageIndices } from "@plinycode/core"
import { extractJsonObjects } from "../router/router-classifier"
import { messageToText } from "./conversation-search"
import { normalizeEntryText } from "./memory-file"

const MAX_DISTILL_TRANSCRIPT_CHARS = 24_000
const MAX_MEMORY_CONTEXT_CHARS = 8_000
const MAX_PROPOSED_MEMORIES = 8

interface DistilledMemory {
	scope: "repo" | "user"
	text: string
	importance: "high" | "normal"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * The conversation from message `fromIndex` on, as compact text: what was
 * said, which tools ran on what, and the start of each result. Side questions
 * are left out. When too long, the start of the conversation is cut, since
 * the end is where its conclusions are.
 */
export function buildDistillTranscript(messages: readonly unknown[], fromIndex = 0): string {
	const hidden = offTheRecordMessageIndices(messages as Parameters<typeof offTheRecordMessageIndices>[0])
	const parts: string[] = []
	for (let index = Math.max(0, fromIndex); index < messages.length; index++) {
		if (hidden.has(index)) continue
		const text = messageToText(messages[index]).trim()
		if (!text) continue
		parts.push(`${String(asRecord(messages[index])?.role ?? "unknown").toUpperCase()}: ${text}`)
	}
	const transcript = parts.join("\n\n")
	return transcript.length > MAX_DISTILL_TRANSCRIPT_CHARS
		? `[earlier messages cut]\n…${transcript.slice(transcript.length - MAX_DISTILL_TRANSCRIPT_CHARS)}`
		: transcript
}

const EDIT_TOOLS = new Set(["editor", "apply_patch", "write_to_file", "replace_in_file"])

/** Whether the messages from `fromIndex` on hold an edit tool call that did not fail. */
export function hasSuccessfulEdit(messages: readonly unknown[], fromIndex = 0): boolean {
	const editCalls = new Set<string>()
	const failed = new Set<string>()
	for (let index = Math.max(0, fromIndex); index < messages.length; index++) {
		const content = asRecord(messages[index])?.content
		if (!Array.isArray(content)) continue
		for (const block of content) {
			const item = asRecord(block)
			if (item?.type === "tool_use" && typeof item.name === "string" && EDIT_TOOLS.has(item.name)) {
				editCalls.add(String(item.id))
			} else if (item?.type === "tool_result" && item.is_error === true) {
				failed.add(String(item.tool_use_id))
			}
		}
	}
	return [...editCalls].some((id) => !failed.has(id))
}

export const DISTILL_SYSTEM_PROMPT = `You maintain the long-term memory of an AI coding assistant. You read one conversation between a user and the assistant, and the memory as it is now, and propose new memories worth keeping for later conversations.

A good memory is something a later conversation would need and could not easily find in the code: a non-obvious convention or constraint of this repository, a gotcha and how to avoid it, a decision and the reason for it, a command or workflow that works, or a preference the user stated about how to work.
Do not propose: what the code or its docs already say, what is already in the memory, one-off details of this task, guesses, or secrets (keys, passwords, tokens).

Output one JSON object and nothing else:
{"memories": [{"text": "<one line, at most 200 characters, self-contained>", "scope": "repo" | "user", "importance": "high" | "normal"}]}

- scope "user" only for the user's personal preferences that apply to every repository; everything else is "repo".
- importance "high" only when forgetting it would cause real mistakes.
- At most ${MAX_PROPOSED_MEMORIES} memories, the most valuable first. Most conversations deserve zero to three. If nothing is worth keeping, output {"memories": []}.`

export function buildDistillUserPrompt(transcript: string, repoMemory: string, userMemory: string): string {
	const cap = (text: string) =>
		text.trim().length > MAX_MEMORY_CONTEXT_CHARS ? `${text.trim().slice(0, MAX_MEMORY_CONTEXT_CHARS)}\n…` : text.trim()
	return [
		"<current_repository_memory>",
		cap(repoMemory) || "(empty)",
		"</current_repository_memory>",
		"",
		"<current_user_memory>",
		cap(userMemory) || "(empty)",
		"</current_user_memory>",
		"",
		"<conversation>",
		transcript,
		"</conversation>",
	].join("\n")
}

/** The memories in the model's reply, normalized, minus any already in `existing`. */
export function parseDistillReply(reply: string, existing: string): DistilledMemory[] {
	const known = existing.toLowerCase().replace(/\s+/g, " ")
	const seen = new Set<string>()
	const memories: DistilledMemory[] = []
	for (const object of extractJsonObjects(reply)) {
		if (!Array.isArray(object.memories)) continue
		for (const raw of object.memories) {
			const item = asRecord(raw)
			const text = typeof item?.text === "string" ? normalizeEntryText(item.text) : ""
			const key = text.toLowerCase().replace(/\s+/g, " ")
			if (!text || seen.has(key) || known.includes(key)) continue
			seen.add(key)
			memories.push({
				text,
				scope: item?.scope === "user" ? "user" : "repo",
				importance: item?.importance === "high" ? "high" : "normal",
			})
			if (memories.length >= MAX_PROPOSED_MEMORIES) return memories
		}
		break
	}
	return memories
}
