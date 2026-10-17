import * as vscode from "vscode"
import { buildEffectiveProviderConfig } from "@/sdk/model-catalog/effective-config"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { requestPlinyBudget } from "@/sdk/pliny-budget"
import { onProviderError, type ProviderErrorInfo } from "@/sdk/provider-error-events"
import { Logger } from "@/shared/services/Logger"
import type { PlinyApiKeys } from "./pliny-api-keys"

/** At most one budget check per this interval: a failing run can report many errors. */
const BUDGET_CHECK_INTERVAL_MS = 60_000

const MANAGE_KEYS = "Manage Keys"

type FailureReason = "rejected" | "budget"

export interface PlinyKeyFailoverDeps {
	keys: Pick<PlinyApiKeys, "activeId" | "activeKey" | "list" | "nextAfter" | "setActive">
	checkBudget: (key: string) => Promise<Awaited<ReturnType<typeof requestPlinyBudget>>>
	ask: (message: string, items: string[]) => Thenable<string | undefined>
	openSettings: () => void
	now?: () => number
}

/**
 * Offers the next stored Pliny API key when the active one stops working:
 * the gateway rejected it (401/403), or its budget is used up. Nothing in a
 * failed request says reliably that the budget ran out, so any other failure
 * asks the budget endpoint, at most once a minute.
 *
 * It never switches by itself: a switch changes whose budget pays, so the
 * user decides. One offer per key and reason; once every key failed, only
 * Settings is offered.
 */
export class PlinyKeyFailover {
	private readonly failed = new Set<string>()
	private readonly offered = new Set<string>()
	private lastBudgetCheck = Number.NEGATIVE_INFINITY

	constructor(private readonly deps: PlinyKeyFailoverDeps) {}

	/** The user picked `id` (here or in Settings): it gets a fresh chance. */
	activeChanged(id: string | undefined): void {
		if (!id) return
		this.failed.delete(id)
		this.offered.delete(`${id}:rejected`)
		this.offered.delete(`${id}:budget`)
	}

	async handle(info: ProviderErrorInfo): Promise<void> {
		const activeId = this.deps.keys.activeId()
		const activeKey = this.deps.keys.activeKey()
		// A key from providers.json or PLINY_API_KEY: there is no stored key to switch to.
		if (!activeId || !activeKey) return
		const reason = info.errorClass === "auth" ? "rejected" : await this.checkBudget(activeKey)
		if (!reason || this.offered.has(`${activeId}:${reason}`)) return
		// The active key may have changed while the budget was checked.
		if (this.deps.keys.activeId() !== activeId) return
		this.offered.add(`${activeId}:${reason}`)
		this.failed.add(activeId)

		const name = this.deps.keys.list().find((k) => k.id === activeId)?.name ?? "the active key"
		const problem =
			reason === "rejected"
				? `The Pliny gateway rejected the API key "${name}".`
				: `The Pliny API key "${name}" has used up its budget.`
		const next = this.deps.keys.nextAfter(activeId, this.failed)
		if (!next) {
			const choice = await this.deps.ask(`${problem} Add or choose another key in Settings.`, [MANAGE_KEYS])
			if (choice === MANAGE_KEYS) this.deps.openSettings()
			return
		}
		const switchTo = `Switch to "${next.name}"`
		const choice = await this.deps.ask(`${problem} Switch to "${next.name}" and click Retry?`, [switchTo, MANAGE_KEYS])
		if (choice === switchTo) {
			await this.deps.keys.setActive(next.id)
			Logger.log(`[PlinyKeyFailover] Switched the active Pliny API key to "${next.name}" (${reason})`)
		} else if (choice === MANAGE_KEYS) {
			this.deps.openSettings()
		}
	}

	private async checkBudget(key: string): Promise<FailureReason | undefined> {
		const now = (this.deps.now ?? Date.now)()
		if (now - this.lastBudgetCheck < BUDGET_CHECK_INTERVAL_MS) return undefined
		this.lastBudgetCheck = now
		try {
			const { status, budget } = await this.deps.checkBudget(key)
			if (status === 401 || status === 403) return "rejected"
			if (budget && (budget.isBlocked || (budget.remaining <= 0 && budget.mode === "enforce"))) return "budget"
		} catch (error) {
			Logger.warn(`[PlinyKeyFailover] Budget check failed: ${error instanceof Error ? error.message : error}`)
		}
		return undefined
	}
}

/** Listens for failed model requests in this window and offers the next stored key. */
export function registerPlinyKeyFailover(context: vscode.ExtensionContext, keys: PlinyApiKeys): void {
	const failover = new PlinyKeyFailover({
		keys,
		checkBudget: (key) => requestPlinyBudget(key, buildEffectiveProviderConfig(parseProviderId("pliny"))),
		ask: (message, items) => vscode.window.showWarningMessage(message, ...items),
		openSettings: () => void vscode.commands.executeCommand("cline.settingsButtonClicked"),
	})
	context.subscriptions.push(
		onProviderError((info) => {
			failover.handle(info).catch((error) => Logger.warn(`[PlinyKeyFailover] ${error}`))
		}),
		keys.onDidChange(() => failover.activeChanged(keys.activeId())),
	)
}
