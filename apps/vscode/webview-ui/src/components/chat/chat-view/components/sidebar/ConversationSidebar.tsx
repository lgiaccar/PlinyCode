import type { ClineMessage } from "@shared/ExtensionMessage"
import { List, MessageSquare, PanelLeftClose, Terminal, Zap } from "lucide-react"
import React, { useCallback, useMemo } from "react"
import { cn } from "@/lib/utils"

export interface SidebarItem {
	id: string
	label: string
	type: "task" | "user" | "tool" | "browser" | "api" | "text" | "checkpoint" | "other"
	groupIndex: number
	ts: number
}

interface Props {
	groupedMessages: (ClineMessage | ClineMessage[])[]
	onItemClick: (groupIndex: number) => void
	onClose?: () => void
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s
	return s.slice(0, n - 3) + "..."
}

function getText(m: ClineMessage): string {
	if (m.text) return m.text
	if (m.type === "say" && m.say) return m.say
	if (m.type === "ask" && m.ask) return m.ask
	return ""
}

export function buildSidebarItems(msgs: (ClineMessage | ClineMessage[])[]): SidebarItem[] {
	const items: SidebarItem[] = []
	for (let i = 0; i < msgs.length; i++) {
		const g = msgs[i]
		if (Array.isArray(g)) {
			const first = g[0]
			let toolName: string | undefined
			let isBrowser = false
			if (first.text) {
				try {
					const parsed = JSON.parse(first.text)
					toolName = parsed.tool
					if (parsed.browser_action || parsed.action) isBrowser = true
				} catch {
					/* ignore */
				}
			}
			items.push({
				id: `t-${first.ts ?? i}`,
				label: isBrowser ? "Browser session" : toolName || "Tool call",
				type: isBrowser ? "browser" : "tool",
				groupIndex: i,
				ts: first.ts ?? i,
			})
		} else if (g.type === "say") {
			if (g.say === "task") {
				items.push({
					id: `task-${g.ts ?? i}`,
					label: truncate(getText(g), 40) || "Task",
					type: "task",
					groupIndex: i,
					ts: g.ts ?? i,
				})
			} else if (g.say === "user_feedback") {
				items.push({
					id: `u-${g.ts ?? i}`,
					label: truncate(getText(g), 40) || "User",
					type: "user",
					groupIndex: i,
					ts: g.ts ?? i,
				})
			} else if (g.say === "api_req_started") {
				items.push({ id: `api-${g.ts ?? i}`, label: "API request", type: "api", groupIndex: i, ts: g.ts ?? i })
			} else if (g.say === "text") {
				items.push({
					id: `txt-${g.ts ?? i}`,
					label: truncate(getText(g), 35) || "Text",
					type: "text",
					groupIndex: i,
					ts: g.ts ?? i,
				})
			} else if (g.say === "checkpoint_created") {
				items.push({ id: `chk-${g.ts ?? i}`, label: "Checkpoint", type: "checkpoint", groupIndex: i, ts: g.ts ?? i })
			}
		}
	}
	return items
}

const typeIcons: Record<string, typeof List> = {
	task: Zap,
	user: MessageSquare,
	tool: Terminal,
	browser: Terminal,
	api: Terminal,
	text: MessageSquare,
	checkpoint: Zap,
	other: List,
}

const typeLabels: Record<string, string> = {
	task: "Task",
	user: "User",
	tool: "Tool",
	browser: "Browser",
	api: "API",
	text: "Text",
	checkpoint: "Checkpoint",
	other: "Other",
}

export const ConversationSidebar: React.FC<Props> = ({ groupedMessages, onItemClick, onClose }) => {
	const items = useMemo(() => buildSidebarItems(groupedMessages), [groupedMessages])
	const handleClick = useCallback(
		(item: SidebarItem) => {
			onItemClick(item.groupIndex)
		},
		[onItemClick],
	)

	return (
		<div className="flex flex-col h-full w-56 border-l border-[var(--vscode-panel-border)] bg-[var(--vscode-sidebar-background)]">
			<div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border)]">
				<span className="text-xs font-semibold text-[var(--vscode-foreground)]">Outline</span>
				{onClose && (
					<button
						className="p-1 rounded hover:bg-[var(--vscode-list-hoverBackground)] text-[var(--vscode-foreground)] cursor-pointer"
						onClick={onClose}
						title="Close sidebar"
						type="button">
						<PanelLeftClose className="w-3.5 h-3.5" />
					</button>
				)}
			</div>
			<div className="flex-1 overflow-y-auto py-1" style={{ scrollbarWidth: "thin" }}>
				{items.length === 0 && (
					<div className="flex items-center justify-center p-4 h-full">
						<span className="text-xs text-[var(--vscode-descriptionForeground)]">No items</span>
					</div>
				)}
				{items.map((item) => {
					const Icon = typeIcons[item.type]
					return (
						<button
							className={cn(
								"w-full text-left px-3 py-1.5 flex items-start gap-2 text-xs cursor-pointer border-l-2 transition-colors",
								"border-transparent hover:bg-[var(--vscode-list-hoverBackground)] text-[var(--vscode-foreground)]",
								item.type === "task" && "font-semibold",
							)}
							key={item.id}
							onClick={() => handleClick(item)}
							title={`${typeLabels[item.type]}: ${item.label}`}
							type="button">
							<Icon className="w-3 h-3 mt-0.5 flex-shrink-0 opacity-70" />
							<span className="truncate leading-tight">{item.label}</span>
						</button>
					)
				})}
			</div>
			{items.length > 0 && (
				<div className="px-3 py-1.5 border-t border-[var(--vscode-panel-border)] text-[10px] text-[var(--vscode-descriptionForeground)]">
					{items.length} item{items.length !== 1 ? "s" : ""}
				</div>
			)}
		</div>
	)
}
