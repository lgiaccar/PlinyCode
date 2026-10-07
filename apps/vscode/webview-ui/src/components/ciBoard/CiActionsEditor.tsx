import { type CiActionInfo, UpdateCiTargetRequest } from "@shared/proto/cline/ci_board"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { CiBoardServiceClient } from "@/services/grpc-client"
import { errorText } from "./useCiBoard"

const PROMPT_KINDS = [
	{ value: "builtin", label: "Built-in: fix CI & conflicts" },
	{ value: "file", label: "Prompt file" },
	{ value: "text", label: "Prompt text" },
]

const TRIGGERS = [
	{ value: "manual", label: "On click only" },
	{ value: "on_failure", label: "When CI fails" },
	{ value: "on_conflict", label: "When the PR conflicts" },
	{ value: "on_failure_or_conflict", label: "When CI fails or the PR conflicts" },
]

const field = "bg-input-background text-input-foreground border border-input-border rounded px-1.5 py-0.5 text-xs"

const newAction = (): CiActionInfo => ({
	id: `a${Date.now().toString(36)}`,
	label: "Investigate",
	promptKind: "file",
	promptValue: "",
	trigger: "manual",
})

/**
 * The prompts a target can run. A file path may be relative to the
 * repository, so a prompt checked into the repository follows the branch.
 */
export const CiActionsEditor = ({
	targetId,
	actions,
	onDone,
}: {
	targetId: string
	actions: CiActionInfo[]
	onDone: () => void
}) => {
	const [draft, setDraft] = useState<CiActionInfo[]>(actions.map((a) => ({ ...a })))
	const [error, setError] = useState<string>()

	const change = (index: number, patch: Partial<CiActionInfo>) =>
		setDraft((list) => list.map((a, i) => (i === index ? { ...a, ...patch } : a)))

	const browse = async (index: number) => {
		const picked = await CiBoardServiceClient.pickCiPromptFile(EmptyRequest.create({}))
		if (picked.value) change(index, { promptValue: picked.value })
	}

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

	return (
		<div className="flex flex-col gap-2 p-2 my-1 bg-code-block-background rounded" data-testid="ci-actions-editor">
			{draft.map((action, index) => (
				<div className="flex flex-col gap-1 pb-2 border-b border-editor-group-border" key={action.id}>
					<div className="flex items-center gap-1">
						<input
							aria-label="Action name"
							className={`${field} flex-1`}
							onChange={(e) => change(index, { label: e.target.value })}
							value={action.label}
						/>
						<Button
							disabled={draft.length <= 1}
							onClick={() => setDraft((list) => list.filter((_, i) => i !== index))}
							size="xs"
							title="Remove this action"
							variant="ghost">
							<span className="codicon codicon-trash" />
						</Button>
					</div>
					<select
						aria-label="Prompt"
						className={field}
						onChange={(e) => change(index, { promptKind: e.target.value, promptValue: "" })}
						value={action.promptKind}>
						{PROMPT_KINDS.map((k) => (
							<option key={k.value} value={k.value}>
								{k.label}
							</option>
						))}
					</select>
					{action.promptKind === "file" && (
						<div className="flex items-center gap-1">
							<input
								aria-label="Prompt file"
								className={`${field} flex-1`}
								onChange={(e) => change(index, { promptValue: e.target.value })}
								placeholder="AI_prompts/pipelines_failures_investigation.md"
								value={action.promptValue}
							/>
							<Button onClick={() => browse(index)} size="xs" variant="secondary">
								Browse…
							</Button>
						</div>
					)}
					{action.promptKind === "text" && (
						<textarea
							aria-label="Prompt text"
							className={field}
							onChange={(e) => change(index, { promptValue: e.target.value })}
							placeholder="What should the agent do with this pull request? {{prId}}, {{sourceBranch}}, {{targetBranch}} and {{worktree}} are filled in."
							rows={4}
							value={action.promptValue}
						/>
					)}
					<label className="flex items-center gap-1 text-xs text-description">
						Runs automatically
						<select
							aria-label="Trigger"
							className={field}
							onChange={(e) => change(index, { trigger: e.target.value })}
							title="Used by the Auto and Full auto modes"
							value={action.trigger}>
							{TRIGGERS.map((t) => (
								<option key={t.value} value={t.value}>
									{t.label}
								</option>
							))}
						</select>
					</label>
				</div>
			))}
			{error && <div className="text-xs text-error">{error}</div>}
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
