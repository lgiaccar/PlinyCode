import type { DeliveryCategory, DeliverySnapshot } from "@shared/delivery"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

const categories: [DeliveryCategory, string][] = [
	["checks", "Tests and checks"],
	["pullRequest", "Recorded PR commands"],
	["ci", "Recorded CI commands"],
	["release", "Publication"],
]

export function DeliveryCard({ onContinue }: { onContinue?: (text: string) => void }) {
	const { currentTaskItem } = useExtensionState()
	const [snapshot, setSnapshot] = useState<DeliverySnapshot>()
	const [error, setError] = useState<string>()
	const [revision, setRevision] = useState(0)
	const taskId = currentTaskItem?.id
	useEffect(() => {
		let cancelled = false
		setSnapshot(undefined)
		setError(undefined)
		if (taskId)
			TaskServiceClient.getDeliveryEvidence({ value: taskId })
				.then((result) => {
					if (!cancelled) setSnapshot(JSON.parse(result.value))
				})
				.catch(() => {
					if (!cancelled) setError("Recorded evidence could not be loaded.")
				})
		return () => {
			cancelled = true
		}
	}, [taskId, revision])
	if (!taskId) return null
	return (
		<section aria-label="Delivery" className="pc-panel mt-2 border border-border rounded-sm p-2 text-xs">
			<div className="flex items-center justify-between gap-2">
				<strong>Delivery</strong>
				<button onClick={() => setRevision((value) => value + 1)} type="button">
					Refresh evidence
				</button>
			</div>
			<p className="text-description">
				Recorded tool results and a read-only remote check. Command output alone does not prove publication.
			</p>
			{error ? (
				<p role="alert">{error}</p>
			) : !snapshot ? (
				<p role="status">Loading evidence…</p>
			) : (
				<>
					{snapshot.remoteError && <p>{snapshot.remoteError}</p>}
					{snapshot.remote && (
						<div className="break-words">
							<p>
								Branch: {snapshot.remote.branch} · Checked {new Date(snapshot.remote.checkedAt).toLocaleString()}
							</p>
							<p>
								{snapshot.remote.pr ? (
									<a href={snapshot.remote.pr.url}>
										PR #{snapshot.remote.pr.id} · {snapshot.remote.pr.state}
									</a>
								) : (
									"No pull request found for this branch."
								)}
							</p>
							{snapshot.remote.pr?.head && (
								<p>
									Remote PR head: <code>{snapshot.remote.pr.head.slice(0, 12)}</code>
								</p>
							)}
							<details>
								<summary className="cursor-pointer">
									CI ·{" "}
									{snapshot.remote.checks.length
										? `${snapshot.remote.checks.filter((c) => c.status === "completed" && c.result === "success").length}/${snapshot.remote.checks.length} checks passed`
										: "No checks reported"}
								</summary>
								<p>Reported checks only; this is not a merge approval.</p>
								{snapshot.remote.checks.map((check, index) => (
									<p key={`${check.name}-${index}`}>
										{check.name} · {check.result ?? check.status}
									</p>
								))}
							</details>
						</div>
					)}
					{categories.map(([category, label]) => {
						const entries = snapshot.evidence.filter((item) => item.category === category)
						return (
							<details className="pc-row border-t border-border py-2" key={category}>
								<summary className="cursor-pointer">
									<strong>{label}</strong> ·{" "}
									{entries.length
										? `${entries.length} recorded result${entries.length === 1 ? "" : "s"}`
										: category === "pullRequest" || category === "ci"
											? "None"
											: "Not confirmed"}
								</summary>
								{entries.length === 0 ? (
									<p>
										No matching tool result was recorded. Shell commands with custom names may not be
										recognized.
									</p>
								) : (
									entries.map((entry) => (
										<details className="mt-2" key={entry.id}>
											<summary className="cursor-pointer break-words">
												{entry.tool}
												{entry.failed ? " · tool reported an error" : " · inspect result"}
												{entry.at ? ` · ${new Date(entry.at).toLocaleString()}` : ""}
											</summary>
											<pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto bg-code p-2">
												{entry.input}
												{"\n\n"}
												{entry.output}
											</pre>
											{entry.truncated && (
												<p>Preview shortened. The full result remains in the conversation.</p>
											)}
										</details>
									))
								)}
							</details>
						)
					})}
					{snapshot.omitted > 0 && <p>{snapshot.omitted} older results omitted from this card.</p>}
				</>
			)}
			{onContinue && (
				<button
					className="mt-2"
					onClick={() =>
						onContinue(
							"Verify this task's delivery against the current commit: inspect the changes, test results, pull request, required CI checks, and any published release assets. Report evidence and anything still missing. Do not publish or merge without existing authorization.",
						)
					}
					type="button">
					Verify delivery with agent
				</button>
			)}
		</section>
	)
}
