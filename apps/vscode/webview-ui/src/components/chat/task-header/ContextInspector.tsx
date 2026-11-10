import type { ContextInspection } from "@shared/context-inspector"
import { useEffect, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

export function ContextInspector({ taskId, onClose }: { taskId: string; onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null)
	const [inspection, setInspection] = useState<ContextInspection>()
	const [error, setError] = useState<string>()
	const [selected, setSelected] = useState<number>()
	const [query, setQuery] = useState("")
	const [revision, setRevision] = useState(0)
	useEffect(() => {
		dialog.current?.showModal()
	}, [])
	useEffect(() => {
		let cancelled = false
		setError(undefined)
		TaskServiceClient.inspectContext({ value: taskId })
			.then((response) => {
				if (cancelled) return
				const next: ContextInspection = JSON.parse(response.value)
				setInspection(next)
				setSelected((previous) =>
					next.requests.some((request) => request.id === previous) ? previous : next.requests.at(-1)?.id,
				)
			})
			.catch(() => {
				if (!cancelled) setError("Captured requests could not be loaded.")
			})
		return () => {
			cancelled = true
		}
	}, [taskId, revision])
	const request = inspection?.requests.find((entry) => entry.id === selected)
	const sections =
		request?.sections.filter((section) =>
			`${section.label} ${section.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
		) ?? []
	return (
		<dialog
			aria-label="Context inspector"
			className="pc-surface fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-sidebar-background text-foreground p-4 overflow-auto"
			onCancel={onClose}
			ref={dialog}>
			<div className="flex justify-between items-center gap-2">
				<h2 className="text-base">Context inspector</h2>
				<button onClick={onClose} type="button">
					Done
				</button>
			</div>
			<p className="text-xs text-description">
				Read-only snapshots from this extension session. Up to three recent requests per conversation are retained, for
				eight conversations.
			</p>
			<button onClick={() => setRevision((value) => value + 1)} type="button">
				Refresh requests
			</button>
			{error && <p role="alert">{error}</p>}
			{!inspection ? (
				<p role="status">{error ? "Refresh to try again." : "Loading captured requests…"}</p>
			) : !request ? (
				<p>No captured request is available. Send a message in this conversation to capture its next request.</p>
			) : (
				<>
					<label className="block text-xs mt-3">
						Request
						<select
							aria-label="Captured request"
							className="block w-full min-w-0 mt-1"
							onChange={(event) => setSelected(Number(event.target.value))}
							value={selected}>
							{inspection.requests.map((entry) => (
								<option key={entry.id} value={entry.id}>
									#{entry.id} · {new Date(entry.at).toLocaleTimeString()} · ≈
									{entry.estimatedTokens.toLocaleString()} tokens
								</option>
							))}
						</select>
					</label>
					<p className="text-xs break-words">
						{request.modelId} · Captured {new Date(request.at).toLocaleString()} · ≈
						{request.estimatedTokens.toLocaleString()} estimated input tokens
					</p>
					{inspection.omittedRequests > 0 && (
						<p className="text-xs">{inspection.omittedRequests} older request snapshots have been evicted.</p>
					)}
					<details className="pc-panel border border-border rounded-sm p-2 text-xs mb-3">
						<summary className="cursor-pointer">Limits and omissions</summary>
						<ul className="pl-4 list-disc">
							{request.notices.map((notice) => (
								<li key={notice}>{notice}</li>
							))}
						</ul>
					</details>
					<input
						aria-label="Find in captured context"
						className="w-full box-border border border-border bg-input-background p-2 mb-3"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Find a source or text…"
						type="search"
						value={query}
					/>
					{sections.map((section, index) => (
						<details
							className="pc-panel border border-border rounded-sm p-3 mb-2 text-xs"
							key={`${request.id}:${section.label}:${index}`}>
							<summary className="cursor-pointer break-words">
								<strong>{section.label}</strong>
								{section.partial ? " · preview shortened" : ""}
							</summary>
							<pre className="whitespace-pre-wrap break-words max-h-80 overflow-auto bg-code p-2">
								{section.content}
							</pre>
						</details>
					))}
					{sections.length === 0 && <p>No captured sections match this search.</p>}
				</>
			)}
		</dialog>
	)
}
