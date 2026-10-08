// Repo memory and past-conversation search (docs/memory.md):
//
// - memory-store.ts, memory-file.ts, repo-key.ts: the memory files, keyed by repository;
// - memory-section.ts, conversation-memory-snapshots.ts: the `# Memory` system prompt section;
// - memory-tools.ts, conversation-search-tools.ts, install-memory.ts: the tools;
// - memory-distiller.ts, memory-coordinator.ts, memory-model.ts: proposing memories after a run.

import { SessionHistorySearchService } from "@plinycode/core"
import { getMemoryMaxTokens, isConversationSearchEnabled } from "@/hosts/vscode/memory-settings"
import { ConversationMemorySnapshots } from "./conversation-memory-snapshots"
import { ConversationSearch, type ConversationSource } from "./conversation-search"
import type { MemoryInstallDeps } from "./install-memory"
import { MemoryStore } from "./memory-store"

export interface MemoryServices extends MemoryInstallDeps {
	store: MemoryStore
	snapshots: ConversationMemorySnapshots
	search: ConversationSearch
}

/** Wires the memory parts to the VS Code settings and the conversation history. */
export function createMemoryServices(source: ConversationSource): MemoryServices {
	const store = new MemoryStore()
	return {
		store,
		snapshots: new ConversationMemorySnapshots({ getMaxTokens: getMemoryMaxTokens, read: (cwd) => store.read(cwd) }),
		search: new ConversationSearch({
			source,
			createIndex: (host) =>
				new SessionHistorySearchService(host as unknown as ConstructorParameters<typeof SessionHistorySearchService>[0]),
		}),
		isMemoryEnabled: () => getMemoryMaxTokens() > 0,
		isSearchEnabled: isConversationSearchEnabled,
	}
}
