// Distillation: a free utility model reads a finished conversation and
// proposes memories worth keeping (docs/memory.md). Nothing here writes: the
// proposals go to the user as a chat row (memory-coordinator.ts), and only
// the ones they keep are saved.

import { offTheRecordMessageIndices } from "@plinycode/core"
import { extractJsonObjects } from "../router/router-classifier"
import { messageToText } from "./conversation-search"
import { hasNearDuplicate, memoryEntryKey, memoryEntryKeys, normalizeEntryText, stripEntryMeta } from "./memory-file"

const MAX_DISTILL_TRANSCRIPT_CHARS = 24_000
const MAX_MEMORY_CONTEXT_CHARS = 8_000
// Was 8: a repository's memory gained twenty entries in one day, most of
// them a record of what that day's tasks changed, each then sent with every
// request for that repository.
const MAX_PROPOSED_MEMORIES = 4

/**
 * A proposal that records what the conversation did, or restates the code,
 * rather than something a later conversation needs. Rejected before the user
 * sees it, so the row holds only candidates worth a look.
 */
const CHANGE_LOG =
	/^(added|updated|created|removed|renamed|expanded|implemented|fixed|refactored|replaced|introduced|changed|moved|extended|wrote|rewrote|deleted|migrated|merged|reworked)\b/i
const TASK_BOUND = /\b(this (task|pr|pull request|conversation|session)|the current (pr|pull request|task))\b/i
const CODE_FACT =
	/\b(takes|accepts|returns|requires|expects|has no|lacks)\b.*\b(argument|parameter|constructor|overload|signature|return type)s?\b/i

function looksLikeChangeLog(text: string): boolean {
	return CHANGE_LOG.test(text) || TASK_BOUND.test(text) || CODE_FACT.test(text)
}

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

const EDIT_TOOLS = new Set(["editor", "apply_patch", "write_to_file", "replace_in_file", "rename_symbol"])

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

A good memory is something a later conversation would need and could not easily find in the code: a non-obvious convention or constraint of this repository, a gotcha of the environment or the tools and how to avoid it, a decision and the reason for it, a command or workflow that works, or a preference the user stated about how to work.
Do not propose: what the code or its docs already say or a search of the code would show (function signatures, argument orders, which class has which constructor, where a file lives); what this conversation changed, added or fixed (that is in git, not memory); what is already in the memory; one-off details of this task; guesses; or secrets (keys, passwords, tokens).
Bad: "Added FieldIsExpected helper to skip validation for missing baseline fields". Bad: "ExtractFaceBasedTetMesh takes local_num_surface as the third argument". Good: "The CUDA test baseline HexCoreTest_CUDA.json must be updated together with the CPU_MT one, or win_cuda_pipeline fails". Good: "Python is not on PATH on this machine; use py.exe".

Output one JSON object and nothing else:
{"memories": [{"text": "<one line, at most 200 characters, self-contained>", "scope": "repo" | "user", "importance": "high" | "normal"}]}

- scope "user" only for the user's personal preferences that apply to every repository; everything else is "repo".
- importance "high" only when forgetting it would cause a real mistake, and say what the mistake is.
- At most ${MAX_PROPOSED_MEMORIES} memories, the most valuable first. Most conversations deserve zero or one. If nothing is worth keeping, output {"memories": []}.`

export function buildDistillUserPrompt(transcript: string, repoMemory: string, userMemory: string): string {
	const cap = (raw: string) => {
		// Entry dates mean nothing to the distiller.
		const text = stripEntryMeta(raw).trim()
		return text.length > MAX_MEMORY_CONTEXT_CHARS ? `${text.slice(0, MAX_MEMORY_CONTEXT_CHARS)}\n…` : text
	}
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

/**
 * The memories in the model's reply, normalized, minus any already an entry
 * of `existing` (an exact or near duplicate of a whole entry: a memory that
 * only occurs inside a longer one is new) and any the user dismissed before.
 * The ones left out as duplicates of an entry go to `rediscovered`, so that
 * entry can be marked as used.
 */
export function parseDistillReply(
	reply: string,
	existing: string,
	dismissed: ReadonlySet<string> = new Set(),
	rediscovered: string[] = [],
): DistilledMemory[] {
	const known = memoryEntryKeys(existing)
	const seen = new Set<string>()
	const memories: DistilledMemory[] = []
	for (const object of extractJsonObjects(reply)) {
		if (!Array.isArray(object.memories)) continue
		for (const raw of object.memories) {
			const item = asRecord(raw)
			const text = typeof item?.text === "string" ? normalizeEntryText(item.text) : ""
			const key = memoryEntryKey(text)
			if (!text || seen.has(key) || dismissed.has(key) || looksLikeChangeLog(text)) continue
			if (known.has(key) || hasNearDuplicate(existing, text)) {
				rediscovered.push(text)
				continue
			}
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
