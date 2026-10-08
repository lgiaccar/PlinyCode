/**
 * `search_conversations` and `read_conversation`: let the model look up what
 * was said and done in earlier conversations (docs/memory.md). Both only
 * read, and follow the "Read files" auto-approve toggle.
 */

import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import type { ConversationSearch } from "./conversation-search"

const SEARCH_CONVERSATIONS_TOOL_NAME = "search_conversations"
const READ_CONVERSATION_TOOL_NAME = "read_conversation"

interface ConversationSearchToolDeps {
	search: Pick<ConversationSearch, "search" | "read">
	/** The folder the conversation runs in; searches default to conversations from it. */
	getCwd: () => string
	/** The conversation that is searching, left out of the results. */
	getConversationId: (context: AgentToolContext) => string | undefined
}

function record(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
}

function formatDate(iso: string): string {
	const date = new Date(iso)
	return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10)
}

export function createConversationSearchTools(deps: ConversationSearchToolDeps): AgentTool[] {
	const searchTool: AgentTool = {
		name: SEARCH_CONVERSATIONS_TOOL_NAME,
		description:
			"Full-text search of earlier conversations with the user: their messages, your replies, and the tool calls and " +
			'results. Use it when the user refers to earlier work ("like we did last week", "the bug we fixed before"), or ' +
			"to check how a similar problem was solved before. Every word must match (prefix match). By default only " +
			"conversations in this workspace are searched. Returns one hit per conversation with a snippet; open one with " +
			`${READ_CONVERSATION_TOOL_NAME}.`,
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Words to find, e.g. `pager hang git log`." },
				all_workspaces: { type: "boolean", description: "Search conversations from every workspace. Default false." },
				limit: { type: "number", description: "Most hits to return, 1-25. Default 8." },
			},
			required: ["query"],
		},
		executionMode: "parallel",
		retryable: false,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = record(rawInput)
			const query = typeof input.query === "string" ? input.query.trim() : ""
			if (!query) {
				throw new Error('Send { "query": "<words to find>" }.')
			}
			const allWorkspaces = input.all_workspaces === true
			const hits = await deps.search.search({
				query,
				workspaceRoot: allWorkspaces ? undefined : deps.getCwd(),
				excludeSessionId: deps.getConversationId(context),
				limit: typeof input.limit === "number" ? input.limit : undefined,
			})
			if (hits.length === 0) {
				return `No earlier conversation matches "${query}"${allWorkspaces ? "" : " in this workspace; try all_workspaces: true or fewer words"}.`
			}
			const lines = hits.map(
				(hit) =>
					`- session_id: ${hit.sessionId} (${formatDate(hit.startedAt)}${allWorkspaces ? `, ${hit.workspaceRoot}` : ""})\n` +
					`  title: ${hit.title}\n` +
					(hit.ordinal >= 0 ? `  message ${hit.ordinal} (${hit.role}): ${hit.snippet}` : `  ${hit.snippet}`),
			)
			return `${hits.length} conversation${hits.length === 1 ? "" : "s"} match. Read one with ${READ_CONVERSATION_TOOL_NAME} { session_id, around_message }.\n\n${lines.join("\n")}`
		},
	}

	const readTool: AgentTool = {
		name: READ_CONVERSATION_TOOL_NAME,
		description:
			"Read the messages of an earlier conversation found with search_conversations, around one message or from the " +
			"start. Tool results are shortened.",
		inputSchema: {
			type: "object",
			properties: {
				session_id: { type: "string", description: "A session_id from search_conversations." },
				around_message: { type: "number", description: "The message number of a hit; omit to read from the start." },
			},
			required: ["session_id"],
		},
		executionMode: "parallel",
		retryable: false,
		async execute(rawInput: unknown): Promise<string> {
			const input = record(rawInput)
			const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : ""
			if (!sessionId) {
				throw new Error('Send { "session_id": "<id from search_conversations>" }.')
			}
			const around = typeof input.around_message === "number" ? input.around_message : undefined
			return deps.search.read(sessionId, around)
		},
	}

	return [searchTool, readTool]
}
