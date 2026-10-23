import { MEMORY_TYPES, type MemoryEntry } from "@shared/memory"
import type { MemoryPanelState } from "@shared/memory-panel"
import { useCallback, useEffect, useState } from "react"
import MemoryProposalRow from "@/components/chat/MemoryProposalRow"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { memoryRequest } from "@/services/memory-client"

const fieldClass = "bg-input-background text-input-foreground border border-input-border rounded p-1 w-full"

function EntryEditor({
	entry,
	run,
	disabled,
	usage,
}: {
	entry: MemoryEntry
	run: (input: Record<string, unknown>) => void
	disabled: boolean
	usage?: { used?: string; count?: number }
}) {
	const [text, setText] = useState(entry.text)
	useEffect(() => setText(entry.text), [entry.text])
	const edit = (patch: Record<string, unknown>) => run({ action: "edit", id: entry.id, patch })
	return (
		<li className="flex flex-col gap-2 border-b border-description/20 py-3">
			<textarea
				aria-label="Memory text"
				className={fieldClass}
				maxLength={600}
				onChange={(event) => setText(event.target.value)}
				value={text}
			/>
			<div className="flex gap-2 flex-wrap">
				<Button disabled={disabled || text === entry.text || !text.trim()} onClick={() => edit({ text })}>
					Save edit
				</Button>
				<Button disabled={disabled} onClick={() => edit({ pinned: !entry.pinned })} variant="secondary">
					{entry.pinned ? "Unpin" : "Pin"}
				</Button>
				{(
					[
						["delete", "Delete"],
						["promote", "Promote to AGENTS.md"],
						["finishPromotion", "Finish promotion"],
					] as const
				).map(([action, label]) => (
					<Button disabled={disabled} key={action} onClick={() => run({ action, id: entry.id })} variant="secondary">
						{label}
					</Button>
				))}
			</div>
			<div className="flex gap-2">
				<select
					aria-label="Memory scope"
					className={fieldClass}
					disabled={disabled}
					onChange={(event) => run({ action: "move", id: entry.id, scope: event.target.value })}
					value={entry.scope}>
					{["repo", "group", "user"].map((scope) => (
						<option key={scope}>{scope}</option>
					))}
				</select>
				<select
					aria-label="Memory importance"
					className={fieldClass}
					disabled={disabled}
					onChange={(event) => edit({ importance: event.target.value })}
					value={entry.importance}>
					<option value="high">Important</option>
					<option value="normal">Notes</option>
				</select>
				<select
					aria-label="Memory type"
					className={fieldClass}
					disabled={disabled}
					onChange={(event) => edit({ type: event.target.value })}
					value={entry.type ?? ""}>
					<option value="">Untyped</option>
					{MEMORY_TYPES.map((type) => (
						<option key={type}>{type}</option>
					))}
				</select>
			</div>
			<div className="text-description text-xs">
				Added {entry.added ?? "undated"} · Last used {usage?.used ?? entry.used ?? entry.added ?? "undated"} · Retrieved{" "}
				{usage?.count ?? 0} times
			</div>
		</li>
	)
}

export function MemorySelectionView({ state }: { state: MemoryPanelState }) {
	const selection = state.selection
	if (!selection) return <p>No memory selection captured for this conversation yet.</p>
	return (
		<div className="flex flex-col gap-2">
			<p>
				{selection.loaded.length} entries loaded · {selection.cut.length} left out · about {selection.tokens} /{" "}
				{selection.budget} tokens
			</p>
			<pre className="whitespace-pre-wrap break-words text-xs">
				{selection.text}
				{"\n\n"}
				{selection.relevant}
			</pre>
			{selection.cut.length > 0 && (
				<details>
					<summary>Entries left out</summary>
					<ul className="text-description opacity-60">
						{selection.cut.map((entry) => (
							<li key={entry.id}>{entry.text}</li>
						))}
					</ul>
				</details>
			)}
		</div>
	)
}

export default function MemoryPanel({ inboxOnly = false }: { inboxOnly?: boolean }) {
	const { memoryConfigurationVersion } = useExtensionState()
	const [state, setState] = useState<MemoryPanelState>()
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [filter, setFilter] = useState("")
	const [budget, setBudget] = useState("")
	const refresh = useCallback(() => {
		memoryRequest({ action: "read", configurationVersion: memoryConfigurationVersion })
			.then((value) => {
				setState(value)
				setBudget(String(value.budget))
			})
			.catch((reason) => setError(String(reason)))
	}, [memoryConfigurationVersion])
	useEffect(() => {
		refresh()
		window.addEventListener("pliny-memory-changed", refresh)
		return () => window.removeEventListener("pliny-memory-changed", refresh)
	}, [refresh])
	const run = async (input: Record<string, unknown>) => {
		setBusy(true)
		setError("")
		try {
			const next = await memoryRequest(input)
			setState(next)
			setBudget(String(next.budget))
		} catch (reason) {
			setError(String(reason))
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="flex flex-col gap-3 py-3">
			{error && (
				<p className="text-error" role="alert">
					{error}
				</p>
			)}
			{!state ? (
				<p>Loading memory…</p>
			) : (
				<>
					<h3 className="m-0">
						Memory inbox{" "}
						<span aria-label="Pending memory proposals" role="status">
							(
							{state.pending.reduce(
								(sum, proposal) => sum + proposal.items.filter((item) => !item.autoSaved).length,
								0,
							)}
							)
						</span>
					</h3>
					{state.pending.length ? (
						state.pending.map((proposal) => (
							<MemoryProposalRow
								key={proposal.id}
								message={{
									ts: proposal.createdAt ?? 0,
									type: "say",
									say: "memory_proposal",
									text: JSON.stringify(proposal),
								}}
							/>
						))
					) : (
						<p>No pending proposals.</p>
					)}
					{!inboxOnly && (
						<>
							<label htmlFor="memory-budget">Memory budget (tokens or %)</label>
							<input
								className={fieldClass}
								id="memory-budget"
								onBlur={() => {
									if (budget !== String(state.budget)) void run({ action: "settings", budget })
								}}
								onChange={(event) => setBudget(event.target.value)}
								value={budget}
							/>
							<p className="text-xs text-description">
								auto = the smaller of 4000 tokens or 4% of the model window. Or enter a token count or percentage
								(4%). 0 turns memory off.
							</p>
							<label htmlFor="memory-distill-mode">After a conversation</label>
							<select
								className={fieldClass}
								disabled={busy || state.budget === 0 || state.budget === "0"}
								id="memory-distill-mode"
								onChange={(event) => void run({ action: "settings", distill: event.target.value })}
								value={state.distill}>
								<option value="offer">Propose for review</option>
								<option value="auto">Save normal proposals automatically (with Undo)</option>
								<option value="off">Only on /distill</option>
							</select>
							<p className="text-xs text-description">
								Agent runs propose conventions and gotchas after edits. Plan and Ask runs propose decisions and
								preferences. Important proposals always need review.
							</p>
							<details>
								<summary>Advanced</summary>
								{(Object.keys(state.tuning) as (keyof typeof state.tuning)[]).map((key) => (
									<label className="flex justify-between items-center gap-2 my-2" key={key}>
										{
											{
												userShare: "User share (%)",
												importantCap: "Important cap",
												saveCap: "Saves per conversation",
												staleDays: "Stale age (days)",
												proposalCount: "Proposal count",
											}[key]
										}
										<input
											aria-label={key}
											className={`${fieldClass} max-w-24`}
											defaultValue={state.tuning[key]}
											onBlur={(event) => {
												if (Number(event.target.value) !== state.tuning[key])
													void run({
														action: "settings",
														tuning: { [key]: Number(event.target.value) },
													})
											}}
											type="number"
										/>
									</label>
								))}
							</details>
							<Button disabled={busy} onClick={() => void run({ action: "cleanup" })}>
								Clean up memory now
							</Button>
							{state.adoption.map((candidate) => (
								<Button
									disabled={busy}
									key={candidate.key}
									onClick={() => void run({ action: "adopt", key: candidate.key })}>
									Adopt memory from {candidate.identity}
								</Button>
							))}
							<details>
								<summary>What reached this conversation</summary>
								<MemorySelectionView state={state} />
							</details>
							<label htmlFor="memory-filter">Filter memories</label>
							<input
								className={fieldClass}
								id="memory-filter"
								onChange={(event) => setFilter(event.target.value)}
								value={filter}
							/>
							{(["repo", "group", "user"] as const).map((scope) => (
								<section key={scope}>
									<h3>
										{scope === "group"
											? `Group: ${state.group ?? "unavailable"}`
											: scope === "repo"
												? "Repository"
												: "Your memory"}{" "}
										· {state.entries.filter((entry) => entry.scope === scope).length} entries ·{" "}
										{
											state.entries.filter((entry) => entry.scope === scope && entry.importance === "high")
												.length
										}{" "}
										important
									</h3>
									{(["high", "normal"] as const).map((importance) => (
										<div key={importance}>
											<h4>{importance === "high" ? "Important" : "Notes"}</h4>
											<ul className="list-none p-0">
												{state.entries
													.filter(
														(entry) =>
															entry.scope === scope &&
															entry.importance === importance &&
															entry.text.toLowerCase().includes(filter.toLowerCase()),
													)
													.map((entry) => (
														<EntryEditor
															disabled={busy}
															entry={entry}
															key={entry.id}
															run={(input) => void run(input)}
															usage={state.usage[entry.id]}
														/>
													))}
											</ul>
										</div>
									))}
								</section>
							))}
						</>
					)}
				</>
			)}
		</div>
	)
}
