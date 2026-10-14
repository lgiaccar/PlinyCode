import { type CiActionInfo, type CiSkillInfo, UpdateCiTargetRequest } from "@shared/proto/cline/ci_board"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient } from "@/services/grpc-client"
import { CiTip } from "./CiTip"
import { errorText } from "./useCiBoard"

const field = "bg-input-background text-input-foreground border border-input-border rounded px-1.5 py-0.5 text-xs"

const BUILTIN_TEXT: Record<string, string> = {
	"fix-conflicts": "Merges the target branch in and resolves the conflicts, keeping both sides' intent.",
	recalibrate:
		"Updates expected values of tests that moved slightly, with the repository's own tooling. Never for a regression.",
	"fix-build":
		"Fixes a failed pipeline's build or failing tests in the code. The main button of a single failed pipeline, and of each pipeline in the details.",
	"fix-ci":
		"Fix them all: works out each failed pipeline's problem and applies the fix that fits it (conflicts, build, regression, small delta), pushes and watches CI.",
	investigate: "Explains each failure with its evidence, in Ask mode: no edits, no pushes.",
}

/** Auto-watch may start these on its own. */
const AUTO_CAPABLE = new Set(["fix-conflicts", "recalibrate"])

const SITUATIONS = [
	{ value: "any", label: "Menu only" },
	{ value: "conflict", label: "Main button on conflicts" },
	{ value: "failure", label: "Main button on failures" },
	{ value: "small-delta", label: "Main button on small deltas" },
]

const newAction = (): CiActionInfo => ({
	id: `custom-${Date.now().toString(36)}`,
	label: "My prompt",
	promptKind: "file",
	promptValue: "",
	model: "free",
	situation: "any",
	auto: false,
	builtin: false,
})

const PromptFields = ({ action, onChange }: { action: CiActionInfo; onChange: (patch: Partial<CiActionInfo>) => void }) => {
	const browse = async () => {
		const picked = await CiBoardServiceClient.pickCiPromptFile(EmptyRequest.create({}))
		if (picked.value) onChange({ promptValue: picked.value })
	}
	return (
		<>
			<div className="flex items-center gap-1">
				<CiTip tip="Built-in: the board's own prompt, which follows the repository's matching skill when it has one. File or text: your own prompt instead.">
					<select
						aria-label="Prompt"
						className={field}
						onChange={(e) =>
							onChange({ promptKind: e.target.value, promptValue: e.target.value === "builtin" ? action.id : "" })
						}
						value={action.promptKind}>
						{action.builtin && <option value="builtin">Built-in prompt</option>}
						<option value="file">Prompt file</option>
						<option value="text">Prompt text</option>
					</select>
				</CiTip>
				<CiTip tip="FreeAuto routes each step to a free Pliny model. The current model is the one selected in the chat, which may cost money. Auto-watch always uses FreeAuto.">
					<select
						aria-label="Model"
						className={field}
						onChange={(e) => onChange({ model: e.target.value })}
						value={action.model}>
						<option value="free">FreeAuto (free)</option>
						<option value="current">My current model</option>
					</select>
				</CiTip>
			</div>
			{action.promptKind === "file" && (
				<div className="flex items-center gap-1">
					<input
						aria-label="Prompt file"
						className={cn(field, "flex-1")}
						onChange={(e) => onChange({ promptValue: e.target.value })}
						placeholder="AI_prompts/pipelines_failures_investigation.md"
						value={action.promptValue}
					/>
					<Button onClick={browse} size="xs" variant="secondary">
						Browse…
					</Button>
				</div>
			)}
			{action.promptKind === "text" && (
				<textarea
					aria-label="Prompt text"
					className={field}
					onChange={(e) => onChange({ promptValue: e.target.value })}
					placeholder="What should the agent do with this pull request? {{prId}}, {{sourceBranch}}, {{targetBranch}}, {{worktree}} and {{reportPath}} are filled in."
					rows={4}
					value={action.promptValue}
				/>
			)}
		</>
	)
}

/**
 * A target's actions: the four built-in ones (whose prompt, model and
 * auto-watch permission can be changed) and the user's own. A file path may
 * be relative to the repository, so a prompt checked in follows the branch.
 */
export const CiActionsEditor = ({
	targetId,
	actions,
	skills,
	onDone,
}: {
	targetId: string
	actions: CiActionInfo[]
	skills: CiSkillInfo[]
	onDone: () => void
}) => {
	const [draft, setDraft] = useState<CiActionInfo[]>(actions.map((a) => ({ ...a })))
	const [error, setError] = useState<string>()

	const change = (id: string, patch: Partial<CiActionInfo>) =>
		setDraft((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)))

	const save = async () => {
		setError(undefined)
		try {
			await CiBoardServiceClient.updateCiTarget(
				UpdateCiTargetRequest.create({ id: targetId, actions: draft, setActions: true }),
			)
			onDone()
		} catch (e) {
			setError(errorText(e))
		}
	}

	const builtins = draft.filter((a) => a.builtin)
	const custom = draft.filter((a) => !a.builtin)

	return (
		<div className="flex flex-col gap-2 p-2 my-1 bg-code-block-background rounded text-xs" data-testid="ci-actions-editor">
			<div className="font-medium">Built-in actions</div>
			{builtins.map((action) => {
				const matching = skills.filter((s) => s.actionId === action.id)
				return (
					<div className="flex flex-col gap-1 pb-2 border-b border-editor-group-border" key={action.id}>
						<div className="flex items-center gap-1">
							<input
								aria-label="Action name"
								className={cn(field, "flex-1")}
								onChange={(e) => change(action.id, { label: e.target.value })}
								value={action.label}
							/>
							{AUTO_CAPABLE.has(action.id) && (
								<CiTip tip="When auto-watch is on, it may start this action by itself, in the background, on FreeAuto.">
									<label className="inline-flex items-center gap-1 text-description">
										<input
											aria-label={`Auto-watch may run ${action.label}`}
											checked={action.auto}
											onChange={(e) => change(action.id, { auto: e.target.checked })}
											type="checkbox"
										/>
										Auto-watch
									</label>
								</CiTip>
							)}
						</div>
						<div className="text-description">{BUILTIN_TEXT[action.id]}</div>
						<PromptFields action={action} onChange={(patch) => change(action.id, patch)} />
						{action.promptKind === "builtin" && (
							<div className="text-description">
								{matching.length
									? `Follows this repository's ${matching.map((s) => `/${s.name}`).join(", ")} skill.`
									: action.id === "recalibrate"
										? "No recalibration skill found in this repository: auto-watch will not recalibrate until you give it a prompt."
										: "No matching skill found in this repository; the built-in steps are used."}
							</div>
						)}
					</div>
				)
			})}
			<div className="font-medium">Your actions</div>
			{custom.length === 0 && <div className="text-description">None yet. Add a prompt you run often.</div>}
			{custom.map((action) => (
				<div className="flex flex-col gap-1 pb-2 border-b border-editor-group-border" key={action.id}>
					<div className="flex items-center gap-1">
						<input
							aria-label="Action name"
							className={cn(field, "flex-1")}
							onChange={(e) => change(action.id, { label: e.target.value })}
							value={action.label}
						/>
						<CiTip tip="When this action is the row's main button; otherwise it is in the menu.">
							<select
								aria-label="Situation"
								className={field}
								onChange={(e) => change(action.id, { situation: e.target.value })}
								value={action.situation}>
								{SITUATIONS.map((s) => (
									<option key={s.value} value={s.value}>
										{s.label}
									</option>
								))}
							</select>
						</CiTip>
						<CiTip tip="Remove this action">
							<Button
								aria-label="Remove this action"
								onClick={() => setDraft((list) => list.filter((a) => a.id !== action.id))}
								size="xs"
								variant="ghost">
								<span className="codicon codicon-trash" />
							</Button>
						</CiTip>
					</div>
					<PromptFields action={action} onChange={(patch) => change(action.id, patch)} />
				</div>
			))}
			{error && <div className="text-error">{error}</div>}
			<div className="flex gap-1">
				<Button onClick={() => setDraft((list) => [...list, newAction()])} size="xs" variant="ghost">
					<span className="codicon codicon-add" /> Add action
				</Button>
				<span className="flex-1" />
				<Button onClick={onDone} size="xs" variant="ghost">
					Cancel
				</Button>
				<Button onClick={save} size="xs">
					Save
				</Button>
			</div>
		</div>
	)
}
