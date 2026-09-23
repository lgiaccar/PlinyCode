/**
 * Sticky send mode for the chat input's split send button. The main button
 * sends with the selected mode and shows its icon; the dropdown only changes
 * the mode (persisted per webview in localStorage).
 */

export type SendMode = "default" | "steer" | "queue" | "schedule"

export const SEND_MODES: readonly SendMode[] = ["default", "steer", "queue", "schedule"]

export const SEND_MODE_STORAGE_KEY = "plinycode.sendMode"

export const SEND_MODE_META: Record<SendMode, { icon: string; label: string; tooltip: string }> = {
	default: {
		icon: "codicon-send",
		label: "Send",
		tooltip: "Send (queues while a turn is running)",
	},
	steer: {
		icon: "codicon-zap",
		label: "Send now (steer)",
		tooltip: "Send now: steer the running turn immediately",
	},
	queue: {
		icon: "codicon-list-ordered",
		label: "Queue (wait until turn ends)",
		tooltip: "Queue: send after the current turn ends",
	},
	schedule: {
		icon: "codicon-watch",
		label: "Schedule (choose a time)",
		tooltip: "Schedule: pick a time to send",
	},
}

function isSendMode(value: unknown): value is SendMode {
	return typeof value === "string" && (SEND_MODES as readonly string[]).includes(value)
}

export function loadSendMode(): SendMode {
	try {
		const stored = globalThis.localStorage?.getItem(SEND_MODE_STORAGE_KEY)
		return isSendMode(stored) ? stored : "default"
	} catch {
		return "default"
	}
}

export function saveSendMode(mode: SendMode): void {
	try {
		globalThis.localStorage?.setItem(SEND_MODE_STORAGE_KEY, mode)
	} catch {
		// localStorage can be unavailable; keep the mode in memory only.
	}
}

/** The delivery passed to onSend for a direct-send mode. Schedule has none. */
export function deliveryFor(mode: SendMode): "queue" | "steer" | undefined {
	return mode === "steer" || mode === "queue" ? mode : undefined
}
