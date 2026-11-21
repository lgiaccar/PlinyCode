import { useEffect, useState } from "react";
import type { State, Task } from "./contracts";
import type { PrPreview } from "./pr-contracts";

export function PrDialog({
	task,
	onState,
	close,
}: {
	task: Task;
	onState: (state: State) => void;
	close: () => void;
}) {
	const [preview, setPreview] = useState<PrPreview>();
	const [title, setTitle] = useState(task.title);
	const [body, setBody] = useState("");
	const [target, setTarget] = useState("");
	const [draft, setDraft] = useState(true);
	const [commit, setCommit] = useState(false);
	const [retry, setRetry] = useState(false);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	useEffect(() => {
		void window.plinycode.invoke({ type: "prPreview", id: task.id }).then(
			(result) => {
				setPreview(result.prPreview);
				setTarget(task.pullRequest?.target || result.prPreview?.target || "");
			},
			(error) => setStatus(String(error)),
		);
	}, [task.id, task.pullRequest?.target]);
	async function act(type: "prCreate" | "prRefresh" | "prOpen") {
		setBusy(true);
		setStatus("");
		try {
			const result = await window.plinycode.invoke(
				type === "prCreate"
					? {
							type,
							id: task.id,
							input: {
								title,
								body,
								target,
								draft,
								commit,
								retryUncertain: retry,
							},
						}
					: { type, id: task.id },
			);
			onState(result.state);
			const pr = result.state.tasks.find(
				(item) => item.id === task.id,
			)?.pullRequest;
			setStatus(
				pr?.url
					? `PR #${pr.number} (${pr.status}): ${pr.url}`
					: "No open PR found; inspect the provider before retrying an uncertain create.",
			);
		} catch (error) {
			setStatus(String(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="modal-backdrop">
			<section className="modal pr-dialog">
				<h2>Create pull request</h2>
				{preview && (
					<>
						<p>
							{preview.branch} → {target}
						</p>
						<p>{preview.remote}</p>
						<pre>
							{preview.changes || "Working tree is clean."}
							{"\n"}
							{preview.commits || "No new commits yet."}
						</pre>
					</>
				)}
				<label>
					PR title
					<input
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						disabled={busy}
					/>
				</label>
				<label>
					PR target branch
					<input
						value={target}
						onChange={(event) => setTarget(event.target.value)}
						disabled={busy || !preview}
					/>
				</label>
				<label>
					PR description
					<textarea
						value={body}
						onChange={(event) => setBody(event.target.value)}
						disabled={busy}
						rows={6}
					/>
				</label>
				<label>
					<input
						type="checkbox"
						checked={draft}
						onChange={(event) => setDraft(event.target.checked)}
						disabled={busy}
					/>
					Draft PR
				</label>
				<label>
					<input
						type="checkbox"
						checked={commit}
						onChange={(event) => setCommit(event.target.checked)}
						disabled={busy}
					/>
					Commit all task changes using the PR title
				</label>
				{["uncertain", "creating"].includes(task.pullRequest?.status ?? "") && (
					<label>
						<input
							type="checkbox"
							checked={retry}
							onChange={(event) => setRetry(event.target.checked)}
							disabled={busy}
						/>
						I checked the provider; retry the uncertain creation
					</label>
				)}
				<output>{busy ? "Working…" : status}</output>
				<p>{task.pullRequest?.error}</p>
				<div className="modal-actions">
					<button type="button" disabled={busy} onClick={close}>
						Close PR dialog
					</button>
					<button
						type="button"
						disabled={busy || !preview}
						onClick={() => act("prRefresh")}
					>
						Refresh PR status
					</button>
					{task.pullRequest?.url && (
						<button type="button" disabled={busy} onClick={() => act("prOpen")}>
							Open PR
						</button>
					)}
					<button
						type="button"
						disabled={busy || !preview || !title.trim() || !target.trim()}
						onClick={() => act("prCreate")}
					>
						{commit ? "Commit, push and create PR" : "Push and create PR"}
					</button>
				</div>
			</section>
		</div>
	);
}
