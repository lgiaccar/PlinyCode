/**
 * Plan mode writes its plan as markdown files in a <plans folder>/<slug>/
 * folder (outside the workspace, in PlinyCode's data folder), with
 * PLAN.md as the root file that coordinates the rest. These helpers find that
 * root file from the chat transcript so the plan row can offer "Execute plan".
 */

import type { ClineMessage } from "@shared/ExtensionMessage"
import { clineSayToolPayload, parseSayPayload } from "../../chat-payloads"

const ROOT_PLAN_FILE_NAME = "plan.md"

function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown)$/i.test(path)
}

/** The markdown path an editor tool row wrote, if any. */
function markdownWritePath(message: ClineMessage): string | undefined {
	const isToolRow = (message.type === "say" && message.say === "tool") || (message.type === "ask" && message.ask === "tool")
	if (!isToolRow || !message.text) {
		return undefined
	}
	const parsed = parseSayPayload(message, clineSayToolPayload)
	if (!parsed.ok) {
		return undefined
	}
	const tool = parsed.value
	if (tool.tool !== "newFileCreated" && tool.tool !== "editedExistingFile") {
		return undefined
	}
	const path = tool.path?.trim().replace(/\\/g, "/")
	return path && isMarkdownPath(path) ? path : undefined
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1)
}

/**
 * The root plan file for the plan_completion_result row at `planTs`.
 *
 * Looks at markdown files written during the plan stretch: everything after
 * the previous act-mode completion_result (or the start of the task) up to the
 * plan row, so later follow-up turns that only edit a sub-file still resolve
 * to the same root. Prefers the most recently written PLAN.md, then falls back
 * to the first markdown file written. Undefined when no plan file was written,
 * which usually means the reply was a question rather than a plan.
 */
export function findPlanRootFile(messages: ClineMessage[], planTs: number): string | undefined {
	const planIndex = messages.findIndex((message) => message.ts === planTs)
	if (planIndex < 0) {
		return undefined
	}

	const written: string[] = []
	for (let i = planIndex - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.type === "say" && message.say === "completion_result") {
			break
		}
		const path = markdownWritePath(message)
		if (path) {
			written.push(path)
		}
	}
	// `written` is newest first.
	return written.find((path) => basename(path).toLowerCase() === ROOT_PLAN_FILE_NAME) ?? written.at(-1)
}

/**
 * True when nothing has moved the conversation past the plan row at `planTs`:
 * no newer plan or act result and no newer user message. Rows that trail the
 * plan (request usage bookkeeping and the like) do not count.
 */
export function isLatestPlanResult(messages: ClineMessage[], planTs: number): boolean {
	const planIndex = messages.findIndex((message) => message.ts === planTs)
	if (planIndex < 0) {
		return false
	}
	return !messages
		.slice(planIndex + 1)
		.some(
			(message) =>
				message.type === "say" &&
				(message.say === "plan_completion_result" ||
					message.say === "completion_result" ||
					message.say === "user_feedback"),
		)
}

/** The prompt the Execute plan button sends when it switches to act mode. */
export function executePlanPrompt(rootPlanFile: string): string {
	return `execute the plan in ${rootPlanFile}`
}

/**
 * How the plan link names `planFile`: an absolute path (plans live in
 * PlinyCode's data folder, outside the workspace) is shortened to its plan
 * folder and file name, `<slug>/PLAN.md`; a workspace-relative path is kept.
 */
export function planFileLabel(planFile: string): string {
	const normalized = planFile.replace(/\\/g, "/")
	if (!/^(?:[a-z]:)?\//i.test(normalized)) {
		return planFile
	}
	return normalized.split("/").filter(Boolean).slice(-2).join("/")
}
