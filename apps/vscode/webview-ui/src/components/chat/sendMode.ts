/**
 * Sticky send mode for the chat input's split send button. The main button
 * sends with the selected mode and shows its icon; the dropdown only changes
 * the mode (persisted per webview in localStorage).
 */

export type SendMode = "queue" | "steer" | "interrupt" | "schedule"

export const SEND_MODES: readonly SendMode[] = ["queue", "steer", "interrupt", "schedule"]

/** What onSend receives: "interrupt" stops the running turn first, then sends. */
export type SendDelivery = "queue" | "steer" | "interrupt"

/** Per-message choices that go with a send. */
export interface SendOptions {
	/**
	 * Ask the message as an off-the-record side question: it is answered without
	 * changing any file, and later requests leave the question and its answer out
	 * of the context. See docs/side-questions.md.
	 */
	offTheRecord?: boolean
}

const SEND_MODE_STORAGE_KEY = "plinycode.sendMode"

export const SEND_MODE_META: Record<SendMode, { icon: string; label: string; tooltip: string }> = {
	queue: {
		icon: "codicon-send",
		label: "Queue (after the agent finishes)",
		tooltip:
			"Queue: sends your message after the agent finishes its current turn. If the agent is idle, it sends right away.",
	},
	steer: {
		icon: "codicon-zap",
		label: "Steer (without interrupting)",
		tooltip:
			"Steer: injects your message so the agent reads it right away, without stopping the task. A reply in progress, a wait or a long command stops holding it back.",
	},
	interrupt: {
		icon: "codicon-debug-stop",
		label: "Send (interrupt the agent)",
		tooltip: "Send (interrupt): stops the agent, then sends your message right away.",
	},
	schedule: {
		icon: "codicon-watch",
		label: "Schedule (choose a time)",
		tooltip: "Schedule: pick a time to send this message, and optionally repeat it at an interval.",
	},
}

function isSendMode(value: unknown): value is SendMode {
	return typeof value === "string" && (SEND_MODES as readonly string[]).includes(value)
}

/** Unknown stored values fall back to Queue; "default" was the old name of Queue. */
export function loadSendMode(): SendMode {
	try {
		const stored = globalThis.localStorage?.getItem(SEND_MODE_STORAGE_KEY)
		return isSendMode(stored) ? stored : "queue"
	} catch {
		return "queue"
	}
}

export function saveSendMode(mode: SendMode): void {
	try {
		globalThis.localStorage?.setItem(SEND_MODE_STORAGE_KEY, mode)
	} catch {
		// localStorage can be unavailable; keep the mode in memory only.
	}
}

/** The delivery passed to onSend for a direct-send mode. Queue is the plain send; Schedule has none. */
export function deliveryFor(mode: SendMode): SendDelivery | undefined {
	return mode === "steer" || mode === "interrupt" ? mode : undefined
}
