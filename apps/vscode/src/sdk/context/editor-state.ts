// Editor state attached to the messages a user types: the file they are
// looking at, where their cursor or selection is, and which tabs are open.
//
// It rides inside the user message as an <editor_state> element, which the
// model sees and no display surface shows (stripModeNotices in
// @plinycode/shared removes it wherever user text is rendered: the chat, a
// reopened conversation, the task title, history previews). A conversation
// gets a new block only when it differs from the last one it was sent.

import path from "node:path"
import { extractEditorStateBlock, formatEditorStateBlock } from "@plinycode/shared"
import { Logger } from "@/shared/services/Logger"

export const EDITOR_STATE_MAX_TABS = 20
const MAX_PATH_LENGTH = 300
// Reading the editor goes through the host bridge; a message must not wait on it for long.
const READ_TIMEOUT_MS = 1000
// Conversations whose last block stays in memory; see ConversationGitSnapshots for the same bound.
const MAX_REMEMBERED_CONVERSATIONS = 100

// Said in every block rather than in the system prompt, so the block explains
// itself to whichever model reads it and the prompt does not depend on the setting.
const BLOCK_PREAMBLE =
	"Added by the editor, not typed by the user. It shows what is open in their editor and may be unrelated to the request."
const NOTHING_OPEN = "No file is open in the editor."

export interface EditorState {
	/** Absolute path of the file in the focused editor. */
	activeFile?: string
	/** 1-based first and last line of the selection; the same line for a bare cursor. */
	selection?: { startLine: number; endLine: number }
	/** Absolute paths of the open file tabs, in tab order. */
	openTabs: string[]
}

/** The parts of the host bridge's window service the editor state is read from. */
export interface EditorStateWindow {
	getActiveEditor(request: Record<string, never>): Promise<{
		filePath?: string
		selectionStartLine?: number
		selectionEndLine?: number
		isFile?: boolean
	}>
	getOpenTabs(request: Record<string, never>): Promise<{ paths: string[] }>
}

export async function readEditorState(window: EditorStateWindow): Promise<EditorState> {
	const [active, tabs] = await Promise.all([window.getActiveEditor({}), window.getOpenTabs({})])
	const state: EditorState = {
		// Untitled documents come back as a bare name ("Untitled-1"), not a path.
		openTabs: tabs.paths.filter((tabPath) => path.isAbsolute(tabPath)),
	}
	if (active.filePath && active.isFile) {
		state.activeFile = active.filePath
		if (active.selectionStartLine && active.selectionEndLine) {
			state.selection = { startLine: active.selectionStartLine, endLine: active.selectionEndLine }
		}
	}
	return state
}

function displayPath(filePath: string, cwd: string): string {
	const relative = cwd ? path.relative(cwd, filePath) : ""
	const insideWorkspace = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
	const shown = (insideWorkspace ? relative : filePath).replace(/\\/g, "/").replace(/[\u0000-\u001f\u007f]/g, "")
	const bounded = shown.length > MAX_PATH_LENGTH ? `…${shown.slice(shown.length - MAX_PATH_LENGTH + 1)}` : shown
	// The engine reads a word that starts with "@" as a file mention and would attach that file.
	return bounded.startsWith("@") ? `./${bounded}` : bounded
}

/**
 * The <editor_state> block for `state`, with paths relative to `cwd` where
 * they are inside it. Undefined when no file is open.
 */
export function formatEditorState(state: EditorState, cwd: string): string | undefined {
	if (!state.activeFile && state.openTabs.length === 0) {
		return undefined
	}

	const lines = [BLOCK_PREAMBLE]
	if (state.activeFile) {
		const { selection } = state
		const position = !selection
			? ""
			: selection.startLine === selection.endLine
				? ` (cursor at line ${selection.startLine})`
				: ` (lines ${selection.startLine}-${selection.endLine} selected)`
		lines.push(`Active file: ${displayPath(state.activeFile, cwd)}${position}`)
	}
	if (state.openTabs.length > 0) {
		lines.push("Open tabs:")
		for (const tabPath of state.openTabs.slice(0, EDITOR_STATE_MAX_TABS)) {
			lines.push(`- ${displayPath(tabPath, cwd)}`)
		}
		if (state.openTabs.length > EDITOR_STATE_MAX_TABS) {
			lines.push(`... and ${state.openTabs.length - EDITOR_STATE_MAX_TABS} more`)
		}
	}
	return formatEditorStateBlock(lines.join("\n"))
}

function userMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") {
		return ""
	}
	const { content } = message as { content?: unknown }
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	return content
		.map((block) => {
			const typed = block as { type?: unknown; text?: unknown } | null
			return typed?.type === "text" && typeof typed.text === "string" ? typed.text : ""
		})
		.join("\n")
}

/** The newest <editor_state> block in a conversation's transcript. */
export function findLastEditorStateBlock(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const block = extractEditorStateBlock(userMessageText(messages[index]))
		if (block) {
			return block
		}
	}
	return undefined
}

export interface ConversationEditorStateOptions {
	/** `plinycode.context.editorState`, read on every message. */
	isEnabled: () => boolean
	read: () => Promise<EditorState>
	/** The folder the conversation runs in; paths inside it are shown relative to it. */
	getCwd: () => Promise<string>
	readTimeoutMs?: number
}

export class ConversationEditorState {
	// The block each conversation's model saw last.
	private readonly lastBlock = new Map<string, string>()

	constructor(private readonly options: ConversationEditorStateOptions) {}

	/**
	 * The block to append to the session's next user message, or undefined when
	 * the setting is off, the editor could not be read, or nothing changed
	 * since the last block the conversation was sent.
	 */
	async nextBlock(sessionId: string): Promise<string | undefined> {
		try {
			if (!this.options.isEnabled()) {
				return undefined
			}
			const state = await this.readWithTimeout()
			if (!state) {
				return undefined
			}
			const last = this.lastBlock.get(sessionId)
			// Closing every file is only worth saying to a model that was told something was open.
			const block =
				formatEditorState(state, await this.options.getCwd()) ??
				(last === undefined ? undefined : formatEditorStateBlock(NOTHING_OPEN))
			if (!block || block === last) {
				return undefined
			}
			this.remember(sessionId, block)
			return block
		} catch (error) {
			Logger.debug("[EditorState] Failed to read the editor state:", error)
			return undefined
		}
	}

	/**
	 * Aligns with the transcript a session starts from. A rebuilt or resumed
	 * session carries the blocks sent earlier; a new one, or one whose
	 * transcript was compacted past them, carries none, so the next message
	 * gets a block again.
	 */
	syncWithTranscript(sessionId: string, messages: readonly unknown[] | undefined): void {
		const block = messages ? findLastEditorStateBlock(messages) : undefined
		if (block) {
			this.remember(sessionId, block)
		} else {
			this.lastBlock.delete(sessionId)
		}
	}

	private async readWithTimeout(): Promise<EditorState | undefined> {
		let timer: ReturnType<typeof setTimeout> | undefined
		const timedOut = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), this.options.readTimeoutMs ?? READ_TIMEOUT_MS)
		})
		try {
			return await Promise.race([this.options.read(), timedOut])
		} finally {
			clearTimeout(timer)
		}
	}

	private remember(sessionId: string, block: string): void {
		this.lastBlock.delete(sessionId)
		this.lastBlock.set(sessionId, block)
		while (this.lastBlock.size > MAX_REMEMBERED_CONVERSATIONS) {
			const oldest = this.lastBlock.keys().next().value
			if (oldest === undefined) {
				break
			}
			this.lastBlock.delete(oldest)
		}
	}
}
