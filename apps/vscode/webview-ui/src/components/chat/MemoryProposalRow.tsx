import type { ClineMessage } from "@shared/ExtensionMessage"
import { type MemoryProposal, type MemoryProposalItem, parseMemoryProposal } from "@shared/memory-proposal"
import { ResolveMemoryProposalRequest } from "@shared/proto/cline/task"
import { BrainIcon, LoaderCircleIcon } from "lucide-react"
import { memo, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { TaskServiceClient } from "@/services/grpc-client"

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
	const [checked, setChecked] = useState<Set<string>>(() => new Set(proposal?.items.map((item) => item.id)))
	const [submitting, setSubmitting] = useState(false)
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
		).catch((error) => {
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

	const renderItem = (item: MemoryProposalItem) => (
		<li key={item.id}>
			<label className="flex cursor-pointer items-start gap-2">
				<input
					checked={checked.has(item.id)}
					className="mt-[3px] shrink-0"
					disabled={!pending}
					onChange={(event) => toggle(item.id, event.target.checked)}
					type="checkbox"
				/>
				<span className="min-w-0 break-words">
					{item.text}
					<span className="ml-1 text-description text-xs">
						{item.scope === "user" ? "· your memory" : "· repository memory"}
						{item.importance === "high" ? " · important" : ""}
					</span>
				</span>
			</label>
		</li>
	)

	return (
		<div className="flex flex-col gap-2 py-1" data-testid="memory-proposal-row">
			<div className="flex items-center gap-2 font-bold">
				<BrainIcon className="size-2" />
				<span>{additions.length > 0 ? "Memories worth keeping from this conversation" : "Memory cleanup"}</span>
			</div>
			{additions.length > 0 && <ul className="m-0 flex list-none flex-col gap-1 p-0">{additions.map(renderItem)}</ul>}
			{removals.length > 0 && (
				<>
					<div className="text-description text-xs" data-testid="memory-proposal-removals">
						Not used for 90 days. Checked items are removed; unchecked ones are kept and count as used again.
					</div>
					<ul className="m-0 flex list-none flex-col gap-1 p-0">{removals.map(renderItem)}</ul>
				</>
			)}
			{proposal.error && <div className="text-error text-xs">{proposal.error}</div>}
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
