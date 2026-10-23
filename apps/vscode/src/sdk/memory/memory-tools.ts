/**
 * `save_memory`: adds one entry to the repository's or the user's memory
 * (docs/memory.md).
 *
 * A dedicated tool rather than the editor, so that:
 * - it works in ask mode, which has no editor, and in plan mode;
 * - the entry lands in the right place by importance (memory-file.ts), dated,
 *   and a near duplicate bumps the existing entry's date instead of adding a line;
 * - a side question cannot call it (core's off-the-record guard names it).
 *
 * It follows the "Edit files" auto-approve toggle (sdk-tool-policies.ts): a
 * memory is sent with every later request, so a write prompted by injected
 * text would outlive the conversation.
 */

import type { AgentTool } from "@plinycode/shared"
import { MEMORY_TYPES } from "@shared/memory"
import { normalizeEntryText } from "./memory-file"
import { rankMemories, selectMemories } from "./memory-retrieval"
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
	const scope: MemoryScope =
		scopeValue === "user" || scopeValue === "global" || scopeValue === "personal"
			? "user"
			: scopeValue === "group"
				? "group"
				: "repo"
	const importanceValue = input.importance ?? input.important
	const importance =
		importanceValue === true || (typeof importanceValue === "string" && /^(high|important|critical)$/i.test(importanceValue))
			? "high"
			: "normal"
	const force = input.force === true || (typeof input.force === "string" && /^(true|yes)$/i.test(input.force))
	return {
		...(MEMORY_TYPES.some((type) => type === input.type) ? { type: input.type as MemorySaveInput["type"] } : {}),
		...(input.replace === true ? { replace: true } : {}),
		...(input.remove === true ? { remove: true } : {}),
		scope,
		text: memory,
		importance,
		topic: text(input.topic),
		details: text(input.details),
		...(force ? { force } : {}),
	}
}

interface SaveMemoryToolDeps {
	store: MemoryStore
	/** The folder whose repository the memory belongs to: the session's cwd. */
	getCwd: () => string
	/** The conversation, for the per-conversation cap; the tool context's session id when absent. */
	getConversationId?: () => string | undefined
	/**
	 * `plinycode.memory.maxTokens`, to tell the model when the entry it just
	 * saved falls outside what the prompt will show. Without it the result
	 * does not say.
	 */
	getMaxTokens?: () => number
}

/**
 * Whether a just-saved entry is inside the part of the files the system
 * prompt shows under the budget. Rendering the section the way the next
 * conversation will is the only reliable check: the two memories share one
 * budget, and the user's own takes its quarter first.
 */
async function isShownUnderBudget(deps: SaveMemoryToolDeps, cwd: string, text: string): Promise<boolean | undefined> {
	const maxTokens = deps.getMaxTokens?.()
	if (maxTokens === undefined) {
		return undefined
	}
	try {
		const rendered = selectMemories(await deps.store.read(cwd), maxTokens, text, {}, deps.store.tuning().userShare)
		return `${rendered.text}\n${rendered.relevant}`.includes(normalizeEntryText(text))
	} catch {
		return undefined
	}
}

export function createSaveMemoryTool(deps: SaveMemoryToolDeps): AgentTool {
	return {
		name: SAVE_MEMORY_TOOL_NAME,
		description:
			"Save a memory that later conversations can load or retrieve; the # Memory section says what is worth " +
			"saving. One line per memory. What this task changed belongs in git, not in memory: a change log is refused. " +
			'scope "repo" (default) is shared by every clone of this repository; "user" is for the user\'s personal preferences ' +
			'across all repositories. importance "high" is for a rule or a gotcha whose forgetting would cause a mistake; it is ' +
			"kept only for text that reads as one, and while Important has room under its configured cap. For a longer explanation, " +
			"give `details` and a `topic`: the details go in a topic file that is read on demand, and the one-line memory " +
			"points to it. Set `force` only when the user asked to remember this exact wording.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "The memory, in one line." },
				scope: {
					type: "string",
					enum: ["repo", "group", "user"],
					description:
						'Repo for local conventions, group for organization/project workflows, user for machine facts and personal preferences. Default "repo".',
				},
				type: {
					type: "string",
					enum: [...MEMORY_TYPES],
					description:
						"convention: PR target; gotcha: Conan Debug trap; decision: choice with reason/date; environment: shell path; preference: answer style; reference: catalog URL.",
				},
				replace: { type: "boolean", description: "Correct a near duplicate in place. Defaults to false." },
				remove: {
					type: "boolean",
					description: "Remove a near duplicate the user says is wrong. Confirm the matching entry first.",
				},
				importance: { type: "string", enum: ["high", "normal"], description: 'Default "normal".' },
				topic: { type: "string", description: "Topic file name for `details`, e.g. build-quirks." },
				details: { type: "string", description: "Optional longer markdown, appended to the topic file." },
				force: {
					type: "boolean",
					description:
						"Only when the user asked to remember this exact wording (/remember): skips the change-log check.",
				},
			},
			required: ["text"],
		},
		retryable: false,
		async execute(rawInput: unknown, context?: { sessionId?: string }): Promise<string> {
			const input = parseSaveMemoryInput(rawInput)
			const cwd = deps.getCwd()
			const conversationId = deps.getConversationId?.() ?? context?.sessionId
			const result = await deps.store.save(cwd, { ...input, conversationId })
			if (result.removed !== undefined) return `Removed ${result.removed} matching memories from ${result.file}.`
			if (result.replaced) return `Corrected the matching memory in ${result.file}.`
			if (result.rejected === "change-log") {
				return (
					'Not saved: this reads as a change log ("Fixed …", "Added …", "X now uses …"). Memory is for how to do things ' +
					"and traps, not what this task changed; that is in git. Reword it as a rule or a gotcha, or drop it. If the " +
					"user asked to remember this exact wording, call again with force: true."
				)
			}
			if (result.rejected === "conversation-cap") {
				return `Not saved: this conversation already saved ${deps.store.tuning().saveCap} memories, which is the configured limit. Keep the rest for the final summary, or ask the user to save it with /remember.`
			}
			if (!result.inserted) {
				const existing = result.duplicateOf ? ` as "${result.duplicateOf}"` : ""
				return `That memory is already in ${result.file}${existing}; no line was added, and the existing entry was marked as used today. If the new wording is better, edit that entry instead.`
			}
			const where = result.importance === "high" ? "at the top of Important" : "at the top of Notes"
			const demotion =
				result.demoted === "not-a-rule"
					? " It asked for Important, but Important is for rules and gotchas (when …, never …, use … instead), and this reads as a statement; it went under Notes."
					: result.demoted === "important-full"
						? ` It asked for Important, but Important already holds ${deps.store.tuning().importantCap} entries; it went under Notes. Ask the user to trim Important if this one matters more.`
						: ""
			const topic = result.topicFile ? ` Details were appended to ${result.topicFile}.` : ""
			const shown = await isShownUnderBudget(deps, cwd, input.text)
			const visibility =
				shown === false
					? " It is outside the memory budget for automatic selection. It remains searchable with recall_memory; tell the user."
					: " It is available to later conversations through their memory selection and recall_memory."
			return `Saved to ${result.file}, ${where}.${demotion}${visibility}${topic}`
		},
	}
}

export function createRecallMemoryTool(deps: Pick<SaveMemoryToolDeps, "store" | "getCwd">): AgentTool {
	return {
		name: "recall_memory",
		description:
			"Search repository, group and personal memory for relevant conventions, gotchas, decisions and references. Read a returned topic path with read_files for full details.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		retryable: false,
		async execute(input: unknown, context?: { sessionId?: string }): Promise<string> {
			const query = text((input as { query?: unknown })?.query)
			if (!query) throw new Error("A memory search query is required.")
			const cwd = deps.getCwd()
			const entries = rankMemories(await deps.store.entries(cwd), query, await deps.store.usage(cwd)).slice(0, 10)
			if (context?.sessionId) await deps.store.recordUsage(cwd, context.sessionId, entries)
			const location = await deps.store.locate(cwd)
			return JSON.stringify(entries.map((entry) => ({ ...entry, file: deps.store.fileFor(location, entry.scope) })))
		},
	}
}
