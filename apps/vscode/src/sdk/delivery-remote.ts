import type { DeliverySnapshot } from "@shared/delivery"
import type { HistoryItem } from "@shared/HistoryItem"
import { waitForCiWatchRepoOpener } from "@/services/devops-mcp/builtin-mcp-registry"

/** Read-only, uses this task's folder, never the editor's unrelated active repository. */
export async function inspectDeliveryRemote(item: HistoryItem): Promise<Pick<DeliverySnapshot, "remote" | "remoteError">> {
	try {
		const cwd = item.worktree?.path ?? item.cwdOnTaskInitialization
		if (!cwd || item.worktree?.removedTs) return { remoteError: "Task folder unavailable; remote status not checked." }
		const { ctx, provider } = await (await waitForCiWatchRepoOpener(1000))(cwd)
		const branch = item.worktree?.branch ?? ctx.branch
		if (!branch) return { remoteError: "Detached HEAD; no branch to inspect." }
		const pr = await (provider.findLatestPr?.(branch) ?? provider.findOpenPr(branch))
		const checks = pr ? await provider.prChecks(pr) : []
		if (pr) {
			const fresh = await provider.getPr(pr.id)
			if (fresh.headSha !== pr.headSha || fresh.state !== pr.state)
				return { remoteError: "The PR changed while checking. Refresh to inspect its new state." }
		}
		return {
			remote: {
				branch,
				checkedAt: Date.now(),
				pr: pr ? { id: pr.id, state: pr.state, url: pr.url, head: pr.headSha } : undefined,
				checks: checks.map(({ name, status, result }) => ({ name, status, result })),
			},
		}
	} catch {
		return { remoteError: "Remote status unavailable. Check DevOps authentication and refresh." }
	}
}
