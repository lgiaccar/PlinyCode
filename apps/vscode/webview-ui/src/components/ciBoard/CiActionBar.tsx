import { type CiItem, type CiItemAction, CiItemRequest } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient, UiServiceClient } from "@/services/grpc-client"
import { CiTip } from "./CiTip"
import { errorText, runKey } from "./useCiBoard"

interface CiActionBarProps {
	targetId: string
	item: CiItem
	/** The `runKey` of the run being started, if any. */
	busy?: string
	onRun: (actionId: string, pipeline?: string) => Promise<void>
	onCustomPrompt: () => void
	onEditActions: () => void
	onError: (message: string | undefined) => void
}

/**
 * A row's actions: the one that fits the item's state as the main button (the
 * single fix when one thing is wrong, Fix them all when several are, or Open
 * conversation while a run is going), and the rest in the menu beside it.
 */
export const CiActionBar = ({ targetId, item, busy, onRun, onCustomPrompt, onEditActions, onError }: CiActionBarProps) => {
	const [analyzing, setAnalyzing] = useState(false)
	const [open, setOpen] = useState(false)
	const menuRef = useRef<HTMLDivElement>(null)
	const running = item.conversationStatus === "running" || item.conversationStatus === "background"
	const primary = item.actions.find((a) => a.role === "primary")
	const failing = item.mergeState === "conflicts" || item.pipelines.some((p) => p.color === "red")

	useEffect(() => {
		if (!open) return
		const onDown = (event: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
		}
		document.addEventListener("mousedown", onDown)
		menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus()
		return () => document.removeEventListener("mousedown", onDown)
	}, [open])

	const run = (action: CiItemAction) => {
		setOpen(false)
		void onRun(action.actionId, action.pipeline)
	}

	const openConversation = () =>
		CiBoardServiceClient.openCiConversation(StringRequest.create({ value: item.key })).catch((e) => onError(errorText(e)))

	const analyze = async () => {
		setOpen(false)
		setAnalyzing(true)
		onError(undefined)
		try {
			await CiBoardServiceClient.analyzeCiItem(CiItemRequest.create({ targetId, itemKey: item.key }))
		} catch (e) {
			onError(errorText(e))
		} finally {
			setAnalyzing(false)
		}
	}

	const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			setOpen(false)
			return
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
		event.preventDefault()
		const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])]
		const index = items.indexOf(document.activeElement as HTMLButtonElement)
		const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length
		items[next]?.focus()
	}

	const menuActions = item.actions.filter((a) => a !== primary || running)
	const menuItem =
		"w-full text-left px-2 py-1 bg-transparent border-0 text-menu-foreground cursor-pointer hover:bg-list-hover focus:bg-list-hover focus:outline-none disabled:opacity-50 disabled:cursor-default"

	return (
		<div className="relative inline-flex flex-shrink-0" data-testid="ci-action-bar" ref={menuRef}>
			{running ? (
				<CiTip tip="A run started from the board is still going for this pull request. Open its conversation to follow it.">
					<Button className="rounded-r-none" onClick={openConversation} size="sm" variant="secondary">
						<span className="codicon codicon-comment-discussion" /> Open conversation
					</Button>
				</CiTip>
			) : primary ? (
				<CiTip tip={primary.disabledReason || primary.tooltip} wrap={!!primary.disabledReason}>
					<Button
						className="rounded-r-none"
						data-testid="ci-primary-action"
						disabled={!!busy || !!primary.disabledReason}
						onClick={() => run(primary)}
						size="sm"
						variant={primary.recommended ? "default" : "secondary"}>
						<span
							className={cn(
								"codicon",
								busy === runKey(primary.actionId, primary.pipeline)
									? "codicon-loading codicon-modifier-spin"
									: primary.recommended
										? "codicon-sparkle"
										: "codicon-play",
							)}
						/>
						{primary.label}
					</Button>
				</CiTip>
			) : null}
			<CiTip tip="More actions: the other fixes, a prompt of your own, a new analysis.">
				<Button
					aria-expanded={open}
					aria-haspopup="menu"
					aria-label="More actions"
					className={cn(primary || running ? "rounded-l-none border-l border-l-button-separator px-1" : "")}
					data-testid="ci-more-actions"
					onClick={() => setOpen(!open)}
					size="sm"
					variant="secondary">
					<span className="codicon codicon-chevron-down" />
					{!primary && !running && "Actions"}
				</Button>
			</CiTip>
			{open && (
				<div
					className="absolute right-0 top-[calc(100%+4px)] z-50 w-64 max-w-[80vw] flex flex-col py-1 rounded border border-menu-border bg-menu text-xs shadow-lg"
					onKeyDown={onMenuKey}
					role="menu">
					{menuActions.map((action) => (
						<CiTip key={action.actionId} side="left" tip={action.disabledReason || action.tooltip}>
							<button
								className={menuItem}
								disabled={!!action.disabledReason}
								onClick={() => run(action)}
								role="menuitem"
								type="button">
								<span className="flex items-center gap-1">
									<span className="font-medium">{action.label}</span>
									{action.recommended && (
										<span className="rounded px-1 text-[10px] bg-button-background/30 text-button-foreground">
											Recommended
										</span>
									)}
								</span>
								<span className="block text-description">{action.description}</span>
							</button>
						</CiTip>
					))}
					<hr className="my-1 border-0 border-t border-menu-border" />
					<CiTip
						side="left"
						tip="Write a prompt, or pick a prompt file, and run it on this pull request once. You can keep it as an action.">
						<button
							className={menuItem}
							disabled={!!item.runBlocked}
							onClick={() => {
								setOpen(false)
								onCustomPrompt()
							}}
							role="menuitem"
							type="button">
							<span className="codicon codicon-edit text-[11px]" /> Run a custom prompt…
						</button>
					</CiTip>
					{failing && (
						<CiTip side="left" tip="Read the failed runs again and ask a free model for a new summary and severity.">
							<button className={menuItem} disabled={analyzing} onClick={analyze} role="menuitem" type="button">
								<span className="codicon codicon-sync text-[11px]" /> Analyze failures again
							</button>
						</CiTip>
					)}
					{item.url && (
						<button
							className={menuItem}
							onClick={() => {
								setOpen(false)
								UiServiceClient.openUrl(StringRequest.create({ value: item.url })).catch(console.error)
							}}
							role="menuitem"
							type="button">
							<span className="codicon codicon-link-external text-[11px]" /> Open pull request
						</button>
					)}
					<CiTip side="left" tip="Change the actions' prompts and models, and what auto-watch may run.">
						<button
							className={menuItem}
							onClick={() => {
								setOpen(false)
								onEditActions()
							}}
							role="menuitem"
							type="button">
							<span className="codicon codicon-settings-gear text-[11px]" /> Edit actions…
						</button>
					</CiTip>
				</div>
			)}
		</div>
	)
}
