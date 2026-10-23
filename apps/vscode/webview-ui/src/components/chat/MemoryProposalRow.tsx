import type { ClineMessage } from "@shared/ExtensionMessage"
import { type MemoryProposal, type MemoryProposalItem, parseMemoryProposal } from "@shared/memory-proposal"
import { ResolveMemoryProposalRequest } from "@shared/proto/cline/task"
import { BrainIcon, LoaderCircleIcon } from "lucide-react"
import { memo, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { TaskServiceClient } from "@/services/grpc-client"
import { memoryRequest } from "@/services/memory-client"

interface MemoryProposalRowProps {
	message: ClineMessage
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

function statusLine(proposal: MemoryProposal): string | undefined {
	switch (proposal.status) {
		case "saving":
			return "Saving…"
		case "saved": {
			const parts: string[] = []
			if (proposal.savedCount) parts.push(`Saved ${plural(proposal.savedCount, "memory", "memories")}`)
			if (proposal.removedCount) parts.push(`removed ${plural(proposal.removedCount, "item", "items")}`)
			if (parts.length > 0) {
				const line = parts.join(", ")
				return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`
			}
			return proposal.removedCount === undefined
				? "Nothing new was saved: the memory already had these."
				: "Nothing was changed: the kept entries count as used again."
		}
		case "dismissed":
			return "Dismissed."
		default:
			return undefined
	}
}

/**
 * Memories a utility model proposed from this conversation, and memory
 * entries not used for 90 days proposed for removal (docs/memory.md).
 * Nothing is saved or removed until the user presses the button: each item
 * can be unchecked first. The extension updates the same row (same ts) once
 * the choice is applied.
 */
const MemoryProposalRow = memo(({ message }: MemoryProposalRowProps) => {
	const proposal = parseMemoryProposal(message.text)
	// Removals start checked; every proposal, important or not, starts
	// unchecked: "Save" without a look used to fill a repository's memory with
	// change logs the distiller had marked important.
	const [checked, setChecked] = useState<Set<string>>(
		() => new Set(proposal?.items.filter((item) => item.action === "remove").map((item) => item.id)),
	)
	const [submitting, setSubmitting] = useState(false)
	const [actionError, setActionError] = useState("")
	const status = proposal?.status

	// The extension re-emits the row (same ts) once the choice is applied, or
	// with an error and still pending: either way the local busy state ends.
	// biome-ignore lint/correctness/useExhaustiveDependencies: proposal?.error is a trigger, not a value read here
	useEffect(() => {
		setSubmitting(false)
	}, [status, proposal?.error])

	if (!proposal) {
		return null
	}
	const pending = proposal.status === "pending" && !submitting
	const resolve = (save: boolean) => {
		setSubmitting(true)
		TaskServiceClient.resolveMemoryProposal(
			ResolveMemoryProposalRequest.create({ proposalId: proposal.id, save, itemIds: [...checked] }),
		)
			.then(() => window.dispatchEvent(new Event("pliny-memory-changed")))
			.catch((error) => {
				console.error("Failed to resolve the memory proposal:", error)
				setSubmitting(false)
			})
	}
	const toggle = (id: string, on: boolean) => {
		setChecked((previous) => {
			const next = new Set(previous)
			if (on) next.add(id)
			else next.delete(id)
			return next
		})
	}
	const done = statusLine(proposal)
	const additions = proposal.items.filter((item) => item.action !== "remove")
	const removals = proposal.items.filter((item) => item.action === "remove")
	const removalsChecked = removals.some((item) => checked.has(item.id))
	const removalGroups = [
		{
			key: "change-log",
			label: "Reads as a change log: what a task changed belongs in git, not in memory.",
			items: removals.filter((item) => item.reason === "change-log"),
		},
		{
			key: "duplicate",
			label: "Says the same as another entry; the longer wording is kept.",
			items: removals.filter((item) => item.reason === "duplicate"),
		},
		{
			key: "stale",
			label: "Not used for 90 days.",
			items: removals.filter((item) => item.reason !== "change-log" && item.reason !== "duplicate"),
		},
	].filter((group) => group.items.length > 0)

	const renderItem = (item: MemoryProposalItem) => (
		<li key={item.id}>
			<label className="flex cursor-pointer items-start gap-2">
				<input
					checked={checked.has(item.id)}
					className="mt-[3px] shrink-0"
					disabled={!pending || item.autoSaved}
					onChange={(event) => toggle(item.id, event.target.checked)}
					type="checkbox"
				/>
				<span className="min-w-0 break-words">
					{item.text}
					{item.details && (
						<details>
							<summary>Full details</summary>
							<div className="whitespace-pre-wrap">{item.details}</div>
						</details>
					)}
					<span className="ml-1 text-description text-xs">
						{item.scope === "user"
							? "· your memory"
							: item.scope === "group"
								? "· group memory"
								: "· repository memory"}
						{item.importance === "high" ? " · important" : ""}
					</span>
				</span>
			</label>
			{item.autoSaved && (
				<Button
					onClick={() => {
						memoryRequest({ action: "undo", proposalId: proposal.id, itemId: item.id }).catch((reason) =>
							setActionError(String(reason)),
						)
					}}
					size="sm"
					variant="secondary">
					Saved automatically · Undo
				</Button>
			)}
			{(item.autoSaved || proposal.status === "saved") && item.action !== "remove" && (
				<Button
					onClick={() => {
						memoryRequest()
							.then((state) => {
								const entry = state.entries.find(
									(entry) => entry.scope === item.scope && entry.text.startsWith(item.text),
								)
								if (!entry) throw new Error("The saved memory has changed.")
								return memoryRequest({ action: "promote", id: entry.id })
							})
							.catch((reason) => setActionError(String(reason)))
					}}
					size="sm"
					variant="secondary">
					Promote to AGENTS.md
				</Button>
			)}
		</li>
	)

	return (
		<div className="flex flex-col gap-2 py-1" data-testid="memory-proposal-row">
			<div className="flex items-center gap-2 font-bold">
				<BrainIcon className="size-2" />
				<span>{additions.length > 0 ? "Memories worth keeping from this conversation" : "Memory cleanup"}</span>
			</div>
			{additions.length > 0 && <ul className="m-0 flex list-none flex-col gap-1 p-0">{additions.map(renderItem)}</ul>}
			{removalGroups.map((group) => (
				<div className="flex flex-col gap-1" key={group.key}>
					<div className="text-description text-xs" data-testid={`memory-proposal-removals-${group.key}`}>
						{group.label} Checked items are removed; unchecked ones are kept and count as used again.
					</div>
					<ul className="m-0 flex list-none flex-col gap-1 p-0">{group.items.map(renderItem)}</ul>
				</div>
			))}
			{proposal.error && <div className="text-error text-xs">{proposal.error}</div>}
			{actionError && (
				<div className="text-error text-xs" role="alert">
					{actionError}
				</div>
			)}
			{pending ? (
				<div className="flex gap-2">
					<Button disabled={checked.size === 0} onClick={() => resolve(true)}>
						{removalsChecked ? "Apply" : `Save ${checked.size === proposal.items.length ? "all" : `${checked.size}`}`}
					</Button>
					<Button onClick={() => resolve(false)} variant="secondary">
						Dismiss
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-1 text-description text-xs">
					{(submitting || proposal.status === "saving") && <LoaderCircleIcon className="size-2 animate-spin" />}
					{done ?? "Saving…"}
				</div>
			)}
		</div>
	)
})

export default MemoryProposalRow
