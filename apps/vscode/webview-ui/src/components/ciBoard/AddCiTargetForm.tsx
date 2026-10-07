import { AddCiTargetRequest, type CiRepo } from "@shared/proto/cline/ci_board"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { CiBoardServiceClient } from "@/services/grpc-client"
import { classifyCiInput } from "./ciBoardUtils"
import { errorText } from "./useCiBoard"

const field = "bg-input-background text-input-foreground border border-input-border rounded px-1.5 py-1 text-xs"

/**
 * Adds a pull request link, a branch of a workspace repository, or a repository's open pull requests.
 * `existing` is what the board already shows: adding one of those again checks it now and says so.
 */
export const AddCiTargetForm = ({ existing = [] }: { existing?: { id: string; label: string }[] }) => {
	const [repos, setRepos] = useState<CiRepo[]>([])
	const [repoRoot, setRepoRoot] = useState("")
	const [input, setInput] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const [notice, setNotice] = useState<string>()

	useEffect(() => {
		CiBoardServiceClient.listCiRepos(EmptyRequest.create({}))
			.then((list) => {
				setRepos(list.repos)
				setRepoRoot((current) => current || list.repos[0]?.root || "")
			})
			.catch((e) => setError(errorText(e)))
	}, [])

	const kind = classifyCiInput(input)
	const repo = repos.find((r) => r.root === repoRoot)

	const add = async (request: Partial<AddCiTargetRequest>) => {
		setBusy(true)
		setError(undefined)
		setNotice(undefined)
		try {
			const { value: id } = await CiBoardServiceClient.addCiTarget(AddCiTargetRequest.create(request))
			const already = existing.find((t) => t.id === id)
			if (already) {
				setNotice(`Already on the board: ${already.label}. Checking it again now.`)
				await CiBoardServiceClient.refreshCiBoard(StringRequest.create({ value: id }))
			}
			setInput("")
		} catch (e) {
			setError(errorText(e))
		} finally {
			setBusy(false)
		}
	}

	const addInput = () => (kind === "pr" ? add({ kind: "pr", input }) : add({ kind: "branch", input: input.trim(), repoRoot }))

	return (
		<div className="flex flex-col gap-1.5 mb-4" data-testid="add-ci-target">
			<div className="flex items-center gap-1">
				<input
					aria-label="Pull request link or branch"
					className={`${field} flex-1 min-w-0`}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && kind !== "empty" && !busy && addInput()}
					placeholder={
						repo?.currentBranch
							? `PR link, or a branch such as ${repo.currentBranch}`
							: "Pull request link or branch name"
					}
					value={input}
				/>
				<Button disabled={busy || kind === "empty" || (kind === "branch" && !repoRoot)} onClick={addInput} size="xs">
					{kind === "branch" ? "Watch branch" : "Watch PR"}
				</Button>
			</div>
			{repos.length > 0 ? (
				<div className="flex items-center gap-1 text-xs text-description">
					<select
						aria-label="Repository"
						className={`${field} flex-1 min-w-0`}
						onChange={(e) => setRepoRoot(e.target.value)}
						value={repoRoot}>
						{repos.map((r) => (
							<option key={r.root} value={r.root}>
								{r.root}
								{r.currentBranch ? ` (${r.currentBranch})` : ""}
							</option>
						))}
					</select>
					<Button
						disabled={busy || !repoRoot}
						onClick={() => add({ kind: "repo", repoRoot, prFilter: "mine" })}
						size="xs"
						title="Watch every open pull request you created in this repository"
						variant="secondary">
						My open PRs
					</Button>
					<Button
						disabled={busy || !repoRoot}
						onClick={() => add({ kind: "repo", repoRoot, prFilter: "all" })}
						size="xs"
						title="Watch every open pull request in this repository"
						variant="ghost">
						All
					</Button>
				</div>
			) : (
				<div className="text-xs text-description">
					No folder in this window is a git repository on GitHub or Azure DevOps; you can still watch pull request
					links.
				</div>
			)}
			{notice && (
				<div className="text-xs text-description break-words" data-testid="add-ci-target-notice">
					{notice}
				</div>
			)}
			{error && <div className="text-xs text-error break-words">{error}</div>}
		</div>
	)
}
