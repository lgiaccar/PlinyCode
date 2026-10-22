import {
	type CiActionInfo,
	CiBoardState,
	type CiItem,
	type CiSkillInfo,
	type CiTargetView as CiTargetViewProto,
	type CiTriage,
} from "@shared/proto/cline/ci_board"
import { getCiWatchManager } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiBoard, CiTargetView } from "@/services/devops-mcp/ci-board/ci-board"
import { itemActions, pipelineFixes } from "@/services/devops-mcp/ci-board/ci-board-actions"
import type { CiSkills } from "@/services/devops-mcp/ci-board/ci-skills"
import {
	BUILTIN_ACTIONS,
	type CiAction,
	type CiBoardItem,
	type CiPromptSource,
	type CiSituation,
	type CiTriageResult,
	isBuiltinId,
} from "@/services/devops-mcp/ci-board/types"
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
		promptValue:
			action.prompt.kind === "file"
				? action.prompt.path
				: action.prompt.kind === "text"
					? action.prompt.text
					: action.prompt.id,
		model: action.model,
		situation: action.situation,
		auto: action.auto,
		builtin: isBuiltinId(action.id),
	}
}

const SITUATIONS: CiSituation[] = ["conflict", "small-delta", "failure", "any"]

export function fromProtoAction(action: CiActionInfo): CiAction {
	const id = action.id.trim()
	const builtin = BUILTIN_ACTIONS.find((b) => b.id === id)
	const prompt: CiPromptSource =
		action.promptKind === "file"
			? { kind: "file", path: action.promptValue.trim() }
			: action.promptKind === "text"
				? { kind: "text", text: action.promptValue }
				: builtin
					? { kind: "builtin", id: builtin.id as Extract<CiPromptSource, { kind: "builtin" }>["id"] }
					: { kind: "text", text: "" }
	return {
		id,
		label: action.label.trim() || builtin?.label || "Run prompt",
		prompt,
		model: action.model === "current" ? "current" : "free",
		situation:
			builtin?.situation ??
			(SITUATIONS.includes(action.situation as CiSituation) ? (action.situation as CiSituation) : "any"),
		auto: !!builtin?.auto && action.auto,
	}
}

function toProtoTriage(result: CiTriageResult, stale: boolean): CiTriage {
	return {
		status: result.status,
		severity: result.severity,
		summary: result.summary,
		source: result.source,
		analyzedTs: result.analyzedTs,
		reportPath: result.reportPath ?? "",
		stale,
		pipelines: result.pipelines.map((p) => ({
			name: p.name,
			category: p.category,
			summary: p.summary,
			runId: p.runId ?? 0,
			url: p.url ?? "",
			steps: p.steps.map((s) => ({ job: s.job, step: s.step, errors: s.errors, excerpt: s.excerpt ?? "" })),
		})),
		recommended: result.recommended,
		error: result.error ?? "",
		conflict: result.conflict,
	}
}

function toProtoSkills(skills: CiSkills): CiSkillInfo[] {
	return Object.entries(skills).flatMap(([actionId, list]) => list.map((s) => ({ actionId, name: s.name, path: s.path })))
}

function toProtoItem(controller: Controller, board: CiBoard, view: CiTargetView, item: CiBoardItem): CiItem {
	const link = board.linkFor(item.key)
	const pr = item.pr
	const triage = board.triageFor(item)
	const blocked = board.runBlockedReason(view.target, item)
	const auto = view.target.autoWatch ? board.autoState(item.key) : undefined
	const actionContext = {
		actions: view.target.actions,
		item,
		triage: triage && !triage.stale ? triage.result : undefined,
		blocked,
		skills: board.skillsFor(view.target.id),
	}
	const fixes = pipelineFixes(actionContext)
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
		expiredBuildPolicies: (item.expiredBuildPolicies ?? []).map((p) => ({
			evaluationId: p.evaluationId,
			name: p.name,
			buildId: p.buildId ?? 0,
		})),
		conversationId: link?.conversationId ?? "",
		conversationStatus: link ? controller.conversationActivity(link.conversationId) : "",
		watching: link ? getCiWatchManager()?.watching(link.conversationId) !== undefined : false,
		runBlocked: blocked ?? "",
		error: item.error ?? "",
		triage: triage ? toProtoTriage(triage.result, triage.stale) : undefined,
		auto: auto
			? {
					status: auto.status,
					actionId: auto.actionId ?? "",
					attempt: auto.attempt ?? 0,
					maxAttempts: auto.maxAttempts ?? 0,
					message: auto.message,
				}
			: undefined,
		actions: itemActions(actionContext, fixes).map((a) => ({
			...a,
			disabledReason: a.disabledReason ?? "",
			pipeline: a.pipeline ?? "",
		})),
		fixes: fixes.map((f) => ({
			...f,
			actionId: f.actionId ?? "",
			label: f.label ?? "",
			disabledReason: f.disabledReason ?? "",
		})),
		runActionId: link?.actionId ?? "",
		runPipeline: link?.pipeline ?? "",
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
		actions: view.target.actions.map(toProtoAction),
		items: view.items.map((item) => toProtoItem(controller, board, view, item)),
		error: view.error ?? "",
		loading: view.loading,
		autoWatch: view.target.autoWatch,
		skills: toProtoSkills(board.skillsFor(view.target.id)),
	}))
	return CiBoardState.create({ targets, rateLimited: board.rateLimited })
}
