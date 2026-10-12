import { RunCiCustomPromptRequest } from "@shared/proto/cline/ci_board"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient } from "@/services/grpc-client"
import { CiTip } from "./CiTip"
import { errorText } from "./useCiBoard"

const field = "bg-input-background text-input-foreground border border-input-border rounded px-1.5 py-0.5 text-xs"

const PLACEHOLDERS =
	"What should the agent do with this pull request? {{prId}}, {{sourceBranch}}, {{targetBranch}}, {{worktree}} and {{reportPath}} are filled in."

/** Runs a prompt of the user's own on one item, once, and can keep it as an action. */
export const CiCustomPromptPanel = ({ targetId, itemKey, onDone }: { targetId: string; itemKey: string; onDone: () => void }) => {
	const [kind, setKind] = useState<"text" | "file">("text")
	const [value, setValue] = useState("")
	const [model, setModel] = useState<"free" | "current">("free")
	const [save, setSave] = useState(false)
	const [name, setName] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()

	const browse = async () => {
		const picked = await CiBoardServiceClient.pickCiPromptFile(EmptyRequest.create({}))
		if (picked.value) setValue(picked.value)
	}

	const run = async () => {
		setBusy(true)
		setError(undefined)
		try {
			await CiBoardServiceClient.runCiCustomPrompt(
				RunCiCustomPromptRequest.create({
					targetId,
					itemKey,
					promptKind: kind,
					promptValue: value,
					model,
					saveAs: save ? name.trim() || "My prompt" : "",
				}),
			)
			onDone()
		} catch (e) {
			setError(errorText(e))
		} finally {
			setBusy(false)
		}
	}

	const tab = (k: "text" | "file", label: string) => (
		<button
			aria-pressed={kind === k}
			className={cn(
				"bg-transparent border-0 border-b-2 px-1 py-0.5 cursor-pointer text-xs",
				kind === k ? "border-b-button-background text-foreground" : "border-b-transparent text-description",
			)}
			onClick={() => {
				setKind(k)
				setValue("")
			}}
			type="button">
			{label}
		</button>
	)

	return (
		<div className="flex flex-col gap-1.5 p-2 my-1 bg-code-block-background rounded text-xs" data-testid="ci-custom-prompt">
			<div className="flex items-center gap-2">
				<span className="font-medium">Run a custom prompt</span>
				{tab("text", "Write it")}
				{tab("file", "Prompt file")}
			</div>
			{kind === "text" ? (
				<textarea
					aria-label="Prompt text"
					className={field}
					onChange={(e) => setValue(e.target.value)}
					placeholder={PLACEHOLDERS}
					rows={4}
					value={value}
				/>
			) : (
				<div className="flex items-center gap-1">
					<input
						aria-label="Prompt file"
						className={cn(field, "flex-1")}
						onChange={(e) => setValue(e.target.value)}
						placeholder="AI_prompts/pipelines_failures_investigation.md"
						value={value}
					/>
					<CiTip tip="Pick a Markdown or text file. A path inside the repository follows the branch's own copy.">
						<Button onClick={browse} size="xs" variant="secondary">
							Browse…
						</Button>
					</CiTip>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-3 text-description">
				<CiTip tip="FreeAuto routes each step to a free Pliny model. The current model is the one selected in the chat, which may cost money.">
					<label className="inline-flex items-center gap-1">
						Model
						<select
							aria-label="Model"
							className={field}
							onChange={(e) => setModel(e.target.value === "current" ? "current" : "free")}
							value={model}>
							<option value="free">FreeAuto (free)</option>
							<option value="current">My current model</option>
						</select>
					</label>
				</CiTip>
				<label className="inline-flex items-center gap-1">
					<input checked={save} onChange={(e) => setSave(e.target.checked)} type="checkbox" />
					Keep as an action
				</label>
				{save && (
					<input
						aria-label="Action name"
						className={field}
						onChange={(e) => setName(e.target.value)}
						placeholder="Action name"
						value={name}
					/>
				)}
			</div>
			{error && <div className="text-error break-words">{error}</div>}
			<div className="flex gap-1 justify-end">
				<Button onClick={onDone} size="xs" variant="ghost">
					Cancel
				</Button>
				<CiTip tip="Starts a conversation in a working copy of the branch with the pull request's context, then your prompt.">
					<Button disabled={busy || !value.trim()} onClick={run} size="xs">
						<span className={cn("codicon", busy ? "codicon-loading codicon-modifier-spin" : "codicon-play")} /> Run
					</Button>
				</CiTip>
			</div>
		</div>
	)
}
