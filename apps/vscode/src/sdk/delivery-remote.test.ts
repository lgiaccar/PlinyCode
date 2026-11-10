import type { HistoryItem } from "@shared/HistoryItem"
import { beforeEach, expect, it, vi } from "vitest"
import { inspectDeliveryRemote } from "./delivery-remote"

const open = vi.hoisted(() => vi.fn())
vi.mock("@/services/devops-mcp/builtin-mcp-registry", () => ({ waitForCiWatchRepoOpener: async () => open }))
beforeEach(() => {
	open.mockReset()
})

it("checks the task's folder and rejects checks when the PR head changes", async () => {
	const pr = { id: 1, headSha: "old", state: "open", url: "https://example.com/pr/1" }
	open.mockResolvedValue({
		ctx: { branch: "feature" },
		provider: {
			findLatestPr: async () => pr,
			prChecks: async () => [{ name: "test", status: "completed", result: "success" }],
			getPr: async () => ({ ...pr, headSha: "new" }),
		},
	})
	const result = await inspectDeliveryRemote({ cwdOnTaskInitialization: "/task-folder" } as HistoryItem)
	expect(open).toHaveBeenCalledWith("/task-folder")
	expect(result.remote).toBeUndefined()
	expect(result.remoteError).toContain("changed")
})

it("retains merged state and reports no checks without claiming success", async () => {
	const pr = { id: 2, headSha: "head", state: "merged", url: "https://example.com/pr/2" }
	open.mockResolvedValue({
		ctx: { branch: "feature" },
		provider: {
			findLatestPr: async () => pr,
			prChecks: async () => [],
			getPr: async () => pr,
		},
	})
	expect((await inspectDeliveryRemote({ cwdOnTaskInitialization: "/task" } as HistoryItem)).remote).toMatchObject({
		pr: { state: "merged" },
		checks: [],
	})
})

it("does not look up a removed worktree in the editor's current repository", async () => {
	await inspectDeliveryRemote({ worktree: { path: "/removed", removedTs: 1 } } as HistoryItem)
	expect(open).not.toHaveBeenCalled()
})
