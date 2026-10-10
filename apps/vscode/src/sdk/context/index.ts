// Environment context the model gets beyond the conversation itself:
//
// - a git snapshot in the system prompt, taken when the conversation starts
//   (conversation-git-snapshots.ts, git-snapshot.ts);
// - the editor state with each message the user types (editor-state.ts).
//
// docs/environment-context.md describes both.

import { HostProvider } from "@/hosts/host-provider"
import { isEditorStateEnabled, isGitSnapshotEnabled } from "@/hosts/vscode/context-settings"
import { ConversationGitSnapshots, GIT_SNAPSHOT_METADATA_KEY } from "./conversation-git-snapshots"
import { ConversationPromptDates, PROMPT_DATE_METADATA_KEY } from "./conversation-prompt-date"
import { ConversationEditorState, readEditorState } from "./editor-state"
import { gatherGitSnapshot } from "./git-snapshot"

export interface ConversationContext {
	gitSnapshots: ConversationGitSnapshots
	/** The <env> block's date, pinned per conversation like the snapshot. */
	promptDates: ConversationPromptDates
	editorState: ConversationEditorState
	/** What SdkSessionLifecycle stores with every session start of a conversation. */
	sessionStartMetadata: (sessionId: string | undefined) => Record<string, unknown> | undefined
}

export interface ConversationContextOptions {
	/** The metadata stored with a conversation's session record. */
	readSessionMetadata: (conversationId: string) => Promise<Record<string, unknown> | undefined>
	/** The folder the displayed conversation runs in. */
	getWorkspaceRoot: () => Promise<string>
}

/** Wires both parts to the VS Code settings, git and the host bridge. */
export function createConversationContext(options: ConversationContextOptions): ConversationContext {
	const gitSnapshots = new ConversationGitSnapshots({
		isEnabled: isGitSnapshotEnabled,
		gather: (cwd) => gatherGitSnapshot(cwd),
		readStored: async (conversationId) => (await options.readSessionMetadata(conversationId))?.[GIT_SNAPSHOT_METADATA_KEY],
	})
	const promptDates = new ConversationPromptDates({
		today: () => new Date().toLocaleDateString(),
		readStored: async (conversationId) => (await options.readSessionMetadata(conversationId))?.[PROMPT_DATE_METADATA_KEY],
	})
	return {
		gitSnapshots,
		promptDates,
		editorState: new ConversationEditorState({
			isEnabled: isEditorStateEnabled,
			read: () => readEditorState(HostProvider.window),
			getCwd: options.getWorkspaceRoot,
		}),
		sessionStartMetadata: (sessionId) => {
			const git = gitSnapshots.sessionMetadata(sessionId)
			const date = promptDates.sessionMetadata(sessionId)
			return git || date ? { ...(git ?? {}), ...(date ?? {}) } : undefined
		},
	}
}
