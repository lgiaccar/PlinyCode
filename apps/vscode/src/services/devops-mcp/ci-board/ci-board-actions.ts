/**
 * Which actions a board row offers, which one is its main button, and what
 * each one's tooltip says. Pure, so the wording is tested with the logic.
 */
import type { CiSkills } from "./ci-skills"
import { type CiAction, type CiBoardItem, type CiTriageResult, isBuiltinId } from "./types"

interface CiItemAction {
	actionId: string
	label: string
	/** `primary` is the row's main button; the rest go in its menu. */
	role: "primary" | "menu"
	/** The triage says this action fits the item's failures. */
	recommended: boolean
	/** One line for the menu. */
	description: string
	/** What the action does, where and on which model. */
	tooltip: string
	/** Why it cannot run now; empty when it can. */
	disabledReason?: string
}

interface ItemActionContext {
	actions: CiAction[]
	item: CiBoardItem
	/** The item's triage, when it is for the item's current state. */
	triage?: CiTriageResult
	/** Why no action can run on the item (fork, closed, no checkout). */
	blocked?: string
	skills: CiSkills
}

function describe(action: CiAction, item: CiBoardItem): { description: string; tooltip: string } {
	const source = item.pr?.sourceBranch ?? item.branch
	const target = item.pr?.targetBranch ?? "the target branch"
	if (action.prompt.kind === "builtin") {
		switch (action.prompt.id) {
			case "fix-conflicts":
				return {
					description: `Merge ${target} into ${source} and resolve the conflicts.`,
					tooltip: `Merges ${target} into ${source} in a working copy of the branch and resolves the conflicts, keeping both sides' intent. Generated and measured files are regenerated, not hand-merged. Commits and pushes to ${source} only, never with force.`,
				}
			case "recalibrate":
				return {
					description: "Update expected values of tests whose results moved slightly.",
					tooltip: `Updates the expected values of tests whose results moved slightly, using the repository's own recalibration tooling, then pushes to ${source}. It never recalibrates a regression (a worse result, a crash) and stops when the repository documents no tooling.`,
				}
			case "fix-ci":
				return {
					description: "Triage the failures, fix the build and tests, push.",
					tooltip: `Resolves conflicts first if there are any, triages each failed pipeline, fixes build and test failures, pushes to ${source} and watches CI until it finishes. Infrastructure failures are reported for a re-run, not edited around.`,
				}
			case "investigate":
				return {
					description: "Explain why CI fails, without changing anything.",
					tooltip:
						"Explains why each pipeline fails, with the evidence and the next step to take. Runs in Ask mode: it reads code and logs but never edits, commits or pushes.",
				}
		}
	}
	const what =
		action.prompt.kind === "file"
			? `Runs the prompt in ${action.prompt.path}`
			: `Runs your prompt: "${firstLine(action.prompt.kind === "text" ? action.prompt.text : "")}"`
	return { description: what, tooltip: `${what}, in a working copy of ${source}.` }
}

function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/)[0] ?? ""
	return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

/** The actions that fit the item's state, in the order the main button prefers them. */
function primaryFor(ctx: ItemActionContext): CiAction | undefined {
	const { actions, item, triage } = ctx
	if (item.mergeState === "conflicts") {
		return actions.find((a) => a.situation === "conflict")
	}
	if (!item.pipelines.some((p) => p.color === "red")) {
		return undefined
	}
	if (triage?.recommended.includes("recalibrate")) {
		const recalibrate = actions.find((a) => a.situation === "small-delta")
		if (recalibrate) return recalibrate
	}
	return actions.find((a) => a.situation === "failure")
}

export function itemActions(ctx: ItemActionContext): CiItemAction[] {
	const primary = primaryFor(ctx)
	const ordered = primary ? [primary, ...ctx.actions.filter((a) => a !== primary)] : ctx.actions
	return ordered.map((action) => {
		const { description, tooltip } = describe(action, ctx.item)
		const model = action.model === "free" ? "Runs on FreeAuto (free models)." : "Runs on the model selected in the chat."
		const builtin = action.prompt.kind === "builtin" ? action.prompt.id : isBuiltinId(action.id) ? action.id : undefined
		const skills = builtin && action.prompt.kind === "builtin" ? ctx.skills[builtin] : []
		const skillText = skills.length
			? ` Follows this repository's ${skills.map((s) => `/${s.name}`).join(", ")} skill${skills.length > 1 ? "s" : ""}.`
			: ""
		const recommended =
			action === primary || (!!builtin && !!ctx.triage?.recommended.includes(builtin) && action.prompt.kind === "builtin")
		return {
			actionId: action.id,
			label: action.label,
			role: action === primary ? "primary" : "menu",
			recommended,
			description,
			tooltip: `${tooltip}${skillText} ${model}`,
			disabledReason: ctx.blocked,
		}
	})
}
