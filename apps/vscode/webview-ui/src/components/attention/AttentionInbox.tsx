import type { AttentionSnapshot, AttentionStatus } from "@shared/attention"
import { useCallback, useEffect, useRef, useState } from "react"
import { matchesCiStatus } from "@/components/ciBoard/ciBoardFilters"
import { useCiBoard } from "@/components/ciBoard/useCiBoard"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

const labels: Record<AttentionStatus, string> = {
	approval: "Approval",
	question: "Question",
	attention: "Needs attention",
	running: "Running",
	review: "Ready for review",
	reviewed: "Reviewed",
	error: "Run failed",
}
type Tab = "attention" | "running" | "reviewed"

export function AttentionInbox({ onClose }: { onClose: () => void }) {
	const { navigateToChat, navigateToCiBoard, backgroundTasks, turnState } = useExtensionState()
	const dialog = useRef<HTMLDialogElement>(null)
	const [snapshot, setSnapshot] = useState<AttentionSnapshot>()
	const [error, setError] = useState<string>()
	const [tab, setTab] = useState<Tab>("attention")
	const [allWorkspaces, setAllWorkspaces] = useState(false)
	const [pending, setPending] = useState<string>()
	const board = useCiBoard()
	const generation = useRef(0)
	const refresh = useCallback(async () => {
		const ticket = ++generation.current
		try {
			const response = await TaskServiceClient.manageAttention({ value: JSON.stringify({ allWorkspaces }) })
			if (ticket === generation.current) {
				setSnapshot(JSON.parse(response.value))
				setError(undefined)
			}
		} catch {
			if (ticket === generation.current) setError("Attention status could not be refreshed.")
		}
	}, [allWorkspaces])
	useEffect(() => {
		dialog.current?.showModal()
		return () => {
			generation.current++
		}
	}, [])
	useEffect(() => {
		setSnapshot(undefined)
		void refresh()
		const timer = setInterval(() => void refresh(), 15000)
		return () => {
			clearInterval(timer)
			generation.current++
		}
	}, [refresh, backgroundTasks, turnState?.phase])
	const openTask = async (id: string) => {
		setPending(id)
		try {
			await TaskServiceClient.showTaskWithId({ value: id })
			navigateToChat()
			onClose()
		} catch {
			setError("This conversation could not be opened.")
		} finally {
			setPending(undefined)
		}
	}
	const reviewed = async (id: string, updatedAt: number) => {
		setPending(id)
		try {
			await TaskServiceClient.manageAttention({ value: JSON.stringify({ reviewId: id, updatedAt, allWorkspaces }) })
			await refresh()
		} catch {
			setError("The conversation changed or could not be marked reviewed. Refresh and inspect it again.")
		} finally {
			setPending(undefined)
		}
	}
	const tasks = snapshot?.tasks ?? []
	const inTab = (status: AttentionStatus, selected: Tab) =>
		selected === "attention" ? status !== "running" && status !== "reviewed" : status === selected
	const ci =
		board?.targets.flatMap((target) =>
			target.items.filter((item) => matchesCiStatus(item, "attention", target.error)).map((item) => ({ target, item })),
		) ?? []
	return (
		<dialog
			aria-label="Needs attention"
			className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-sidebar-background text-foreground p-4 overflow-auto"
			onCancel={onClose}
			ref={dialog}>
			<div className="flex justify-between items-center gap-2">
				<h2 className="text-base">Needs attention</h2>
				<button onClick={onClose} type="button">
					Done
				</button>
			</div>
			<label className="text-xs">
				<input checked={allWorkspaces} onChange={(event) => setAllWorkspaces(event.target.checked)} type="checkbox" /> All
				workspaces
			</label>
			<p className="text-xs text-description">
				{allWorkspaces ? "Conversations across workspaces" : "Conversations in this workspace"}. Open a conversation to
				inspect and answer its live request.
			</p>
			<div aria-label="Attention filters" className="flex flex-wrap gap-2 my-3">
				{(["attention", "running", "reviewed"] as const).map((value) => (
					<button aria-pressed={tab === value} key={value} onClick={() => setTab(value)} type="button">
						{value === "attention" ? "Attention" : value === "running" ? "Running" : "Reviewed"} (
						{tasks.filter((task) => inTab(task.status, value)).length + (value === "attention" ? ci.length : 0)})
					</button>
				))}
				<button onClick={() => void refresh()} type="button">
					Refresh
				</button>
			</div>
			{error && <p role="alert">{error}</p>}
			{!snapshot ? (
				<p role="status">Loading conversations…</p>
			) : (
				<>
					{tasks
						.filter((task) => inTab(task.status, tab))
						.map((task) => (
							<article className="pc-panel border border-border rounded-sm p-3 mb-2" key={task.id}>
								<div className="flex flex-wrap justify-between gap-2">
									<strong className="break-words min-w-0">{task.title}</strong>
									<span className="text-xs">{labels[task.status]}</span>
								</div>
								<p className="text-xs text-description">
									Last activity {new Date(task.updatedAt).toLocaleString()}
								</p>
								<div className="flex flex-wrap gap-3 text-xs">
									<button disabled={!!pending} onClick={() => void openTask(task.id)} type="button">
										{task.status === "review"
											? "Review changes"
											: task.status === "question"
												? "Answer question"
												: task.status === "approval"
													? "Review approval"
													: "Open conversation"}
									</button>
									{task.status === "review" && (
										<button
											disabled={!!pending}
											onClick={() => void reviewed(task.id, task.updatedAt)}
											type="button">
											Mark reviewed
										</button>
									)}
								</div>
							</article>
						))}
					{tasks.filter((task) => inTab(task.status, tab)).length === 0 && (
						<p className="text-description">No conversations in this view.</p>
					)}
					{snapshot.omitted > 0 && (
						<p className="text-xs">
							Showing the newest 200 conversations; {snapshot.omitted} older conversations remain in History.
						</p>
					)}
				</>
			)}
			{tab === "attention" && (
				<section aria-label="Watched CI">
					<h3 className="text-sm">Watched CI · all repositories</h3>
					{!board ? (
						<p>Loading CI status…</p>
					) : board.unavailable ? (
						<p>{board.unavailable}</p>
					) : (
						<>
							{board.targets
								.filter((target) => target.error)
								.map((target) => (
									<p key={target.id} role="alert">
										{target.label}: {target.error}
									</p>
								))}
							{ci.map(({ target, item }) => (
								<article
									className="pc-panel border border-border rounded-sm p-3 mb-2"
									key={`${target.id}:${item.key}`}>
									<strong className="break-words">{item.title || item.sourceBranch}</strong>
									<p className="text-xs">
										{target.label}
										{item.prId ? ` · PR #${item.prId}` : ""}
									</p>
									<p className="text-xs">
										{item.mergeState === "conflicts"
											? "Merge conflicts"
											: item.expiredBuildPolicies.length
												? "Expired validation"
												: item.error || "CI needs attention"}
									</p>
									<button
										onClick={() => {
											navigateToCiBoard()
											onClose()
										}}
										type="button">
										Inspect in CI Board
									</button>
								</article>
							))}
							{ci.length === 0 && <p className="text-description">No watched CI items need attention.</p>}
						</>
					)}
				</section>
			)}
		</dialog>
	)
}
