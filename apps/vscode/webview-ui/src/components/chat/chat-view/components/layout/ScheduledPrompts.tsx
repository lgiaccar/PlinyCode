import { useState } from "react"

export interface ScheduledPrompt {
	id: string
	text: string
	images: string[]
	files: string[]
	scheduledAt: number
}

interface ScheduledPromptsProps {
	items: ScheduledPrompt[]
	onCancel: (id: string) => void
}

export function ScheduledPrompts({ items, onCancel }: ScheduledPromptsProps) {
	const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set())

	if (items.length === 0) {
		return null
	}

	const handleCancel = (id: string) => {
		setCancellingIds((current) => new Set(current).add(id))
		onCancel(id)
	}

	return (
		<div className="mx-3 mt-2.5 mb-2.5 rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2 shadow-xs">
			<div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-description">
				<span aria-hidden="true" className="codicon codicon-clock text-[12px]" />
				<span>{items.length === 1 ? "Scheduled message" : `${items.length} scheduled messages`}</span>
			</div>
			<div className="flex max-h-28 flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
				{items.map((item) => {
					const scheduledTime = new Date(item.scheduledAt).toLocaleString(undefined, {
						month: "short",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
					})
					const isCancelling = cancellingIds.has(item.id)
					return (
						<div
							className="flex items-start gap-2 rounded-[3px] bg-input-background/40 px-2 py-1.5 text-xs"
							key={item.id}>
							<span aria-hidden="true" className="mt-1.75 size-1.5 shrink-0 rounded-full bg-description/70" />
							<span className="min-w-0 flex-1 break-words text-foreground">
								{item.text.length > 96 ? `${item.text.slice(0, 96)}...` : item.text}
							</span>
							<span className="flex h-5 shrink-0 items-center rounded-[3px] border border-editor-group-border px-1.5 text-[10px] leading-none text-description">
								{scheduledTime}
							</span>
							<button
								aria-label="Cancel scheduled message"
								className="-my-1.5 flex size-5 shrink-0 items-center justify-center rounded-[3px] text-description hover:bg-toolbar-hover-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								disabled={isCancelling}
								onClick={() => handleCancel(item.id)}
								title="Cancel scheduled message"
								type="button">
								<span aria-hidden="true" className="codicon codicon-close text-[12px]" />
							</button>
						</div>
					)
				})}
			</div>
		</div>
	)
}
