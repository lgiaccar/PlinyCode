/**
 * Adds the memory tools to a session's `CoreSessionConfig` (docs/memory.md):
 * `save_memory` while memory is on, and the past-conversation search tools
 * while that setting is on. Both settings are read when the config is built.
 *
 * Sub-agents never get them: core builds their tool list from its built-in
 * tools only, not from `extraTools`.
 */

import type { CoreSessionConfig } from "@plinycode/core"
import type { ConversationSearch } from "./conversation-search"
import { createConversationSearchTools } from "./conversation-search-tools"
import type { MemoryStore } from "./memory-store"
import { createSaveMemoryTool } from "./memory-tools"

export interface MemoryInstallDeps {
	store: MemoryStore
	search: Pick<ConversationSearch, "search" | "read">
	isMemoryEnabled: () => boolean
	isSearchEnabled: () => boolean
}

export function installMemory(config: CoreSessionConfig, cwd: string, deps: MemoryInstallDeps): CoreSessionConfig {
	const tools = [...(config.extraTools ?? [])]
	if (deps.isMemoryEnabled()) {
		tools.push(createSaveMemoryTool({ store: deps.store, getCwd: () => cwd }))
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
	return config
}
