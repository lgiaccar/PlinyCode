/**
 * Sticky send mode for the chat input's split send button. The main button
 * sends with the selected mode and shows its icon; the dropdown only changes
 * the mode (persisted per webview in localStorage).
 *
 * There is no separate "queue" mode: a plain send while a turn is running is
 * already queued until the turn ends.
 */

export type SendMode = "default" | "steer" | "schedule"

export const SEND_MODES: readonly SendMode[] = ["default", "steer", "schedule"]

export const SEND_MODE_STORAGE_KEY = "plinycode.sendMode"

export const SEND_MODE_META: Record<SendMode, { icon: string; label: string; tooltip: string }> = {
	default: {
		icon: "codicon-send",
		label: "Send (waits for current turn)",
		tooltip: "Send: if the agent is busy, sends when the current turn ends",
	},
	steer: {
		icon: "codicon-zap",
		label: "Send now (interrupts)",
		tooltip: "Send now: interrupts the agent's current reply (running tools finish first)",
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

/** Unknown stored values (including the removed "queue" mode) fall back to Send. */
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
export function deliveryFor(mode: SendMode): "steer" | undefined {
	return mode === "steer" ? "steer" : undefined
}
