/**
 * Adds the memory tools to a session's `CoreSessionConfig` (docs/memory.md):
 * `save_memory` while memory is on, and the past-conversation search tools
 * while that setting is on. Both settings are read when the config is built.
 *
 * Sub-agents never get them: core builds their tool list from its built-in
 * tools only, not from `extraTools`.
 */

import { type CoreSessionConfig, isUserRunMessage } from "@plinycode/core"
import { Logger } from "@/shared/services/Logger"
import type { ConversationMemorySnapshots } from "./conversation-memory-snapshots"
import type { ConversationSearch } from "./conversation-search"
import { createConversationSearchTools } from "./conversation-search-tools"
import type { MemorySelection } from "./memory-retrieval"
import type { MemoryStore } from "./memory-store"
import { createRecallMemoryTool, createSaveMemoryTool } from "./memory-tools"

export interface MemoryInstallDeps {
	selection?: Pick<ConversationMemorySnapshots, "get" | "retrieve">
	onSelection?: (selection: MemorySelection) => void
	contextQuery?: string
	store: MemoryStore
	search: Pick<ConversationSearch, "search" | "read">
	isMemoryEnabled: () => boolean
	isSearchEnabled: () => boolean
	/** `plinycode.memory.maxTokens`; lets `save_memory` say when an entry falls outside the budget. */
	getMaxTokens?: () => number
}

export function installMemory(config: CoreSessionConfig, cwd: string, deps: MemoryInstallDeps): CoreSessionConfig {
	const tools = [...(config.extraTools ?? [])]
	if (deps.isMemoryEnabled()) {
		const getMaxTokens = deps.getMaxTokens
		tools.push(
			createSaveMemoryTool({
				store: deps.store,
				getCwd: () => cwd,
				getMaxTokens: getMaxTokens
					? () => deps.selection?.get(config.sessionId ?? "")?.budget ?? getMaxTokens()
					: undefined,
			}),
		)
		tools.push(createRecallMemoryTool({ store: deps.store, getCwd: () => cwd }))
	}
	if (deps.isSearchEnabled()) {
		tools.push(
			...createConversationSearchTools({
				search: deps.search,
				getCwd: () => cwd,
				// The session id is the conversation id; read late, as a new session's is fixed after the build.
				getConversationId: (context) => context.sessionId ?? config.sessionId,
			}),
		)
	}
	config.extraTools = tools
	const base = config.hooks?.beforeModel
	let recorded = false
	config.hooks = {
		...config.hooks,
		beforeModel: async (context) => {
			const result = await base?.(context)
			if (result?.stop || context.snapshot.parentAgentId || !deps.isMemoryEnabled() || !deps.selection || !config.sessionId)
				return result
			const messages = result?.messages ?? context.request.messages
			const first = messages.findIndex((message) => isUserRunMessage(message))
			if (first < 0) return result
			const prompt = JSON.stringify(messages[first].content)
			const editor =
				JSON.stringify(messages.at(-1)?.content ?? "").match(/<editor_state>[\s\S]*?<\/editor_state>/)?.[0] ?? ""
			const selection = deps.selection.retrieve(
				config.sessionId,
				`${prompt}\n${editor}\n${deps.contextQuery ?? ""}`,
				await deps.store.usage(cwd).catch(() => ({})),
			)
			if (!selection) return result
			if (!recorded) deps.onSelection?.(selection)
			const retrieved = selection.loaded.filter((item) => item.tier === "retrieved").map((item) => item.entry)
			if (!recorded)
				await deps.store
					.recordUsage(cwd, config.sessionId, retrieved)
					.catch((error) => Logger.debug("[Memory] Could not record retrieval usage:", error))
			recorded = true
			if (!selection.relevant || prompt.includes("<relevant_memories>")) return result
			const next = [...messages]
			next[first] = { ...next[first], content: [...next[first].content, { type: "text", text: selection.relevant }] }
			return { ...result, messages: next }
		},
	}
	return config
}
