import {
	type CiActionInfo,
	CiBoardState,
	type CiItem,
	type CiTargetView as CiTargetViewProto,
} from "@shared/proto/cline/ci_board"
import { getCiWatchManager } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiBoard, CiTargetView } from "@/services/devops-mcp/ci-board/ci-board"
import type { CiAction, CiBoardItem, CiPromptSource, CiTrigger } from "@/services/devops-mcp/ci-board/types"
import { parseRemote, remoteSlug } from "@/services/devops-mcp/server/repo"
import type { Controller } from "../index"

function label(view: CiTargetView): string {
	const { target } = view
	let slug: string
	try {
		slug = remoteSlug(parseRemote(target.remoteUrl, target.provider))
	} catch {
		slug = target.remoteUrl
	}
	switch (target.kind) {
		case "pr":
			return `${slug} #${target.prId}`
		case "branch":
			return `${slug} @ ${target.branch}`
		case "repo":
			return `${slug}: ${target.prFilter === "all" ? "open PRs" : "my open PRs"}`
	}
}

function toProtoAction(action: CiAction): CiActionInfo {
	return {
		id: action.id,
		label: action.label,
		promptKind: action.prompt.kind,
		promptValue: action.prompt.kind === "file" ? action.prompt.path : action.prompt.kind === "text" ? action.prompt.text : "",
		trigger: action.trigger,
	}
}

const TRIGGERS: CiTrigger[] = ["manual", "on_failure", "on_conflict", "on_failure_or_conflict"]

export function fromProtoAction(action: CiActionInfo): CiAction {
	const prompt: CiPromptSource =
		action.promptKind === "file"
			? { kind: "file", path: action.promptValue.trim() }
			: action.promptKind === "text"
				? { kind: "text", text: action.promptValue }
				: { kind: "builtin" }
	return {
		id: action.id.trim(),
		label: action.label.trim() || "Run prompt",
		prompt,
		trigger: TRIGGERS.includes(action.trigger as CiTrigger) ? (action.trigger as CiTrigger) : "manual",
	}
}

function toProtoItem(controller: Controller, board: CiBoard, view: CiTargetView, item: CiBoardItem): CiItem {
	const link = board.linkFor(item.key)
	const pr = item.pr
	return {
		key: item.key,
		prId: pr?.id ?? 0,
		title: pr?.title ?? "",
		url: pr?.url ?? "",
		sourceBranch: pr?.sourceBranch ?? item.branch,
		targetBranch: pr?.targetBranch ?? "",
		author: pr?.author ?? "",
		draft: pr?.draft ?? false,
		state: pr?.state ?? "",
		headSha: item.headSha ?? "",
		mergeState: item.mergeState ?? "",
		pipelines: item.pipelines.map((p) => ({
			name: p.name,
			color: p.color,
			status: p.status ?? "",
			result: p.result ?? "",
			runId: p.runId ?? 0,
			url: p.url ?? "",
		})),
		conversationId: link?.conversationId ?? "",
		conversationStatus: link ? controller.conversationActivity(link.conversationId) : "",
		watching: link ? getCiWatchManager()?.watching(link.conversationId) !== undefined : false,
		runBlocked: board.runBlockedReason(view.target, item) ?? "",
		error: item.error ?? "",
	}
}

export function toProtoCiBoard(controller: Controller, board: CiBoard | undefined): CiBoardState {
	if (!board) {
		return CiBoardState.create({ unavailable: "The CI board is starting." })
	}
	const targets: CiTargetViewProto[] = board.view().map((view) => ({
		id: view.target.id,
		kind: view.target.kind,
		label: label(view),
		remoteUrl: view.target.remoteUrl,
		provider: view.target.provider,
		checkout: view.checkout ?? "",
		branch: view.target.branch ?? "",
		prId: view.target.prId ?? 0,
		prFilter: view.target.prFilter ?? "",
		autonomy: view.target.autonomy,
		actions: view.target.actions.map(toProtoAction),
		items: view.items.map((item) => toProtoItem(controller, board, view, item)),
		error: view.error ?? "",
		loading: view.loading,
	}))
	return CiBoardState.create({ targets, rateLimited: board.rateLimited })
}
