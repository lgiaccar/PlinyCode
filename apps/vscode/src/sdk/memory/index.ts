// Repo memory and past-conversation search (docs/memory.md):
//
// - memory-store.ts, memory-file.ts, repo-key.ts: the memory files, keyed by repository;
// - memory-section.ts, conversation-memory-snapshots.ts: the `# Memory` system prompt section;
// - memory-tools.ts, conversation-search-tools.ts, install-memory.ts: the tools;
// - memory-distiller.ts, memory-coordinator.ts, memory-model.ts: proposing memories after a run.

import { SessionHistorySearchService } from "@plinycode/core"
import { getMemoryMaxTokens, getMemoryTuning, isConversationSearchEnabled } from "@/hosts/vscode/memory-settings"
import { ConversationMemorySnapshots } from "./conversation-memory-snapshots"
import { ConversationSearch, type ConversationSource, MAX_INDEX_BYTES, MAX_INDEXED_SESSIONS } from "./conversation-search"
import type { MemoryInstallDeps } from "./install-memory"
import { MemoryStore } from "./memory-store"

export interface MemoryServices extends MemoryInstallDeps {
	store: MemoryStore
	snapshots: ConversationMemorySnapshots
	search: ConversationSearch
}

/** Wires the memory parts to the VS Code settings and the conversation history. */
export function createMemoryServices(source: ConversationSource): MemoryServices {
	const store = new MemoryStore({ getTuning: getMemoryTuning })
	const snapshots = new ConversationMemorySnapshots({
		getMaxTokens: getMemoryMaxTokens,
		getUserShare: () => getMemoryTuning().userShare,
		read: (cwd) => store.read(cwd),
	})
	return {
		store,
		snapshots,
		selection: snapshots,
		search: new ConversationSearch({
			source,
			createIndex: (host) =>
				new SessionHistorySearchService(host as unknown as ConstructorParameters<typeof SessionHistorySearchService>[0], {
					maxSessions: MAX_INDEXED_SESSIONS,
					maxDatabaseBytes: MAX_INDEX_BYTES,
				}),
		}),
		isMemoryEnabled: () => getMemoryMaxTokens() > 0,
		isSearchEnabled: isConversationSearchEnabled,
		getMaxTokens: getMemoryMaxTokens,
	}
}
