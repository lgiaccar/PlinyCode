/**
 * Which actions a board row offers, which one is its main button, which single
 * fix fits each of its problems, and what each one's tooltip says. Pure, so
 * the wording is tested with the logic.
 */
import type { CiSkills } from "./ci-skills"
import { type CiAction, type CiBoardItem, type CiBuiltinId, type CiCategory, type CiTriageResult, isBuiltinId } from "./types"

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
	/** The one pipeline it runs on, when it is scoped to one. */
	pipeline?: string
}

/** One problem of an item (its conflicts, or a failed pipeline) and the single fix that fits it. */
interface CiPipelineFix {
	/** Empty for the merge conflicts. */
	pipeline: string
	problem: string
	category: CiCategory | "failed"
	/** Undefined when no fix fits (infrastructure, a stale run). */
	actionId?: string
	label?: string
	tooltip: string
	disabledReason?: string
	/** Other built-in actions that can run on the pipeline alone. */
	alternatives: string[]
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
			case "fix-build":
				return {
					description: "Fix the failed builds and tests in the code, push.",
					tooltip: `Fixes what breaks the failed pipelines (build, compile, lint, or tests failing on a defect) in a working copy of ${source}, then pushes. It never touches expected test values; infrastructure failures are reported for a re-run.`,
				}
			case "fix-ci":
				return {
					description: "Work out each pipeline's problem and apply the fix that fits it.",
					tooltip: `The broad fix: resolves conflicts first, then works out each failed pipeline's problem and applies the fix that fits it (fix the build, fix a regression, recalibrate a small delta), pushes to ${source} and watches CI until it finishes. Infrastructure failures are reported for a re-run, not edited around. When only one thing is wrong, its single fix is safer.`,
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

const PROBLEMS: Record<CiPipelineFix["category"], string> = {
	conflict: "Has conflicts",
	build: "Build failed",
	"test-regression": "Test regression",
	"small-test-delta": "Small test delta",
	infrastructure: "Infrastructure",
	stale: "Stale run",
	unknown: "Unclear failure",
	failed: "Failed",
}

/** The single fix of each kind of failure; none for infrastructure and stale runs. */
const FIX_OF: Partial<Record<CiPipelineFix["category"], CiBuiltinId>> = {
	build: "fix-build",
	"test-regression": "fix-build",
	unknown: "fix-build",
	failed: "fix-build",
	"small-test-delta": "recalibrate",
}

/** What can run on one pipeline alone, in the order a pipeline's menu lists it. */
const PIPELINE_ACTIONS: readonly CiBuiltinId[] = ["fix-build", "recalibrate", "investigate"]

const NO_FIX: Partial<Record<CiPipelineFix["category"], string>> = {
	infrastructure:
		"An infrastructure problem (agent, network, disk or service): re-run the pipeline in CI. There is nothing in the code to fix.",
	stale: "This run tested an older commit. Wait for the run on the pull request's head.",
}

function pipelineTooltip(id: CiBuiltinId, pipeline: string, source: string): string {
	switch (id) {
		case "recalibrate":
			return `Updates the expected values of the tests ${pipeline} runs whose results moved slightly, with the repository's own recalibration tooling, then pushes to ${source}. Never for a regression; stops when the repository documents no tooling.`
		case "investigate":
			return `Explains why ${pipeline} fails, with the evidence and the next step to take. Runs in Ask mode: it never edits, commits or pushes.`
		default:
			return `Fixes what breaks ${pipeline} (build, compile, lint, or tests failing on a defect) in a working copy of ${source}, then pushes. Leaves the other pipelines and the expected test values alone.`
	}
}

function skillText(id: CiBuiltinId | undefined, skills: CiSkills): string {
	const list = id ? skills[id] : []
	return list.length
		? ` Follows this repository's ${list.map((s) => `/${s.name}`).join(", ")} skill${list.length > 1 ? "s" : ""}.`
		: ""
}

const modelText = (action: CiAction) =>
	action.model === "free" ? "Runs on FreeAuto (free models)." : "Runs on the model selected in the chat."

/** The item's problems, conflicts first, each with the single fix that fits it. */
export function pipelineFixes(ctx: ItemActionContext): CiPipelineFix[] {
	const { actions, item, triage, blocked, skills } = ctx
	const source = item.pr?.sourceBranch ?? item.branch
	const byId = (id: string) => actions.find((a) => a.id === id)
	const fixes: CiPipelineFix[] = []
	if (item.mergeState === "conflicts") {
		const action = actions.find((a) => a.situation === "conflict")
		fixes.push({
			pipeline: "",
			problem: PROBLEMS.conflict,
			category: "conflict",
			actionId: action?.id,
			label: action?.label,
			tooltip: action
				? `${describe(action, item).tooltip}${skillText("fix-conflicts", skills)} ${modelText(action)}`
				: "The pull request does not merge cleanly into its target branch.",
			disabledReason: blocked,
			alternatives: [],
		})
	}
	for (const pipeline of item.pipelines.filter((p) => p.color === "red")) {
		const category = triage?.pipelines.find((t) => t.name === pipeline.name)?.category ?? "failed"
		const fixId = FIX_OF[category]
		const action = fixId ? byId(fixId) : undefined
		fixes.push({
			pipeline: pipeline.name,
			problem: PROBLEMS[category],
			category,
			actionId: action?.id,
			label: action?.label,
			tooltip:
				action && fixId
					? `${pipelineTooltip(fixId, pipeline.name, source)}${skillText(fixId, skills)} ${modelText(action)}`
					: (NO_FIX[category] ?? ""),
			disabledReason: blocked,
			alternatives: PIPELINE_ACTIONS.filter((id) => id !== action?.id && byId(id)),
		})
	}
	return fixes
}

/** The row's main button: the single fix when there is one problem, Fix them all when there are several. */
function primaryFor(ctx: ItemActionContext, fixes: CiPipelineFix[]): { action: CiAction; pipeline?: string } | undefined {
	const { actions, item, triage } = ctx
	const conflicts = item.mergeState === "conflicts"
	const red = item.pipelines.filter((p) => p.color === "red")
	const pick = (action: CiAction | undefined, pipeline?: string) => (action ? { action, pipeline } : undefined)
	if (!conflicts && red.length === 0) {
		return undefined
	}
	if (conflicts && red.length === 0) {
		return pick(actions.find((a) => a.situation === "conflict"))
	}
	if (!conflicts && red.length === 1) {
		const fix = fixes.find((f) => f.pipeline === red[0].name)
		const single = pick(
			actions.find((a) => a.id === fix?.actionId),
			red[0].name,
		)
		if (single) return single
	}
	if (!conflicts && triage?.recommended.includes("recalibrate")) {
		const recalibrate = pick(actions.find((a) => a.situation === "small-delta"))
		if (recalibrate) return recalibrate
	}
	return pick(actions.find((a) => a.situation === "failure"))
}

export function itemActions(ctx: ItemActionContext, fixes = pipelineFixes(ctx)): CiItemAction[] {
	const main = primaryFor(ctx, fixes)
	const primary = main?.action
	const scoped = main?.pipeline ? fixes.find((f) => f.pipeline === main.pipeline) : undefined
	const ordered = primary ? [primary, ...ctx.actions.filter((a) => a !== primary)] : ctx.actions
	return ordered.map((action) => {
		const builtin = action.prompt.kind === "builtin" ? action.prompt.id : isBuiltinId(action.id) ? action.id : undefined
		const isPrimary = action === primary
		const { description, tooltip } = describe(action, ctx.item)
		const skills = action.prompt.kind === "builtin" ? skillText(builtin, ctx.skills) : ""
		const recommended =
			isPrimary || (!!builtin && !!ctx.triage?.recommended.includes(builtin) && action.prompt.kind === "builtin")
		return {
			actionId: action.id,
			label: action.label,
			role: isPrimary ? "primary" : "menu",
			recommended,
			description: isPrimary && scoped ? `${scoped.problem}: ${scoped.pipeline}` : description,
			tooltip: isPrimary && scoped ? scoped.tooltip : `${tooltip}${skills} ${modelText(action)}`,
			disabledReason: ctx.blocked,
			pipeline: isPrimary ? scoped?.pipeline : undefined,
		}
	})
}
