import { describe, expect, it, vi } from "vitest"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { Controller as SdkController } from "./SdkController"
import { resolveWorkspaceManagerPaths, resolveWorkspaceRootPath } from "./workspace-root"

describe("isClineManagedProvider", () => {
	it("treats both Cline account providers as Cline providers", () => {
		expect(isClineManagedProvider("cline")).toBe(true)
		expect(isClineManagedProvider("cline-pass")).toBe(true)
		expect(isClineManagedProvider("anthropic")).toBe(false)
		expect(isClineManagedProvider(undefined)).toBe(false)
	})
})

describe("resolveWorkspaceRootPath", () => {
	it("uses the first non-empty workspace path when available", () => {
		expect(resolveWorkspaceRootPath(["", "/workspace"], "/Users/tester/Desktop")).toBe("/workspace")
	})

	it("falls back to Desktop when no workspace folder is open", () => {
		expect(resolveWorkspaceRootPath([], "/Users/tester/Desktop")).toBe("/Users/tester/Desktop")
	})
})

const { openDiffMock, showMessageMock } = vi.hoisted(() => ({
	openDiffMock: vi.fn(async () => ({})),
	showMessageMock: vi.fn(async () => ({})),
}))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		window: { showMessage: showMessageMock },
		diff: { openDiff: openDiffMock, openMultiFileDiff: vi.fn() },
	},
}))

describe("latest checkpoint changes summary", () => {
	const sessionRecord = {
		cwd: "/proj",
		metadata: {
			checkpoint: {
				history: [{ ref: "stash-ref", createdAt: 1, runCount: 7, kind: "stash" }],
			},
		},
	}

	function createCheckpointController(compareCheckpoint: ReturnType<typeof vi.fn>) {
		return Object.assign(Object.create(SdkController.prototype), {
			sessions: {
				getActiveSession: () => ({
					sessionId: "session-1",
					sdkHost: {
						compareCheckpoint,
						get: async () => sessionRecord,
					},
				}),
			},
			task: { taskId: "session-1" },
			getWorkspaceRoot: async () => "/proj",
			latestCheckpointComparisonCache: undefined,
		})
	}

	it("builds a summary from compareCheckpoint and reuses the cache for file diff", async () => {
		openDiffMock.mockClear()
		const compareCheckpoint = vi.fn().mockResolvedValue({
			diffs: [{ filePath: "/proj/src/a.ts", leftContent: "a\n", rightContent: "b\nc\n" }],
		})
		const controller = createCheckpointController(compareCheckpoint)

		const summary = await SdkController.prototype.getLatestCheckpointChangesSummary.call(controller as never)
		expect(summary.files).toHaveLength(1)
		expect(summary.files[0]?.relativePath).toBe("src/a.ts")
		expect(summary.totalAdded).toBe(2)
		expect(summary.totalRemoved).toBe(1)
		expect(summary.checkpointRunCount).toBe(7)
		expect(compareCheckpoint).toHaveBeenCalledTimes(1)

		await SdkController.prototype.openCheckpointFileDiff.call(controller as never, "/proj/src/a.ts", 7)
		expect(compareCheckpoint).toHaveBeenCalledTimes(1)
		expect(openDiffMock).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/proj/src/a.ts",
				leftContent: "a\n",
				rightContent: "b\nc\n",
				title: "src/a.ts (PlinyCode changes)",
			}),
		)
	})

	it("summarizes changes for a specific message checkpoint run", async () => {
		const compareCheckpoint = vi.fn().mockResolvedValue({
			diffs: [{ filePath: "/proj/readme.md", leftContent: "a\n", rightContent: "a\nb\n" }],
		})
		const controller = createCheckpointController(compareCheckpoint)
		controller.task = {
			messageStateHandler: {
				getClineMessages: () => [
					{ ts: 10, type: "say", say: "task", text: "Start" },
					{ ts: 11, type: "say", say: "checkpoint_created", text: "1" },
				],
			},
		}

		const summary = await SdkController.prototype.getCheckpointChangesSummary.call(controller as never, {
			messageTs: 10,
		})
		expect(summary.files).toHaveLength(1)
		expect(summary.checkpointRunCount).toBe(1)
		expect(compareCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", checkpointRunCount: 1 }))
	})
})

describe("resolveWorkspaceManagerPaths", () => {
	it("returns the host's workspace folder paths, dropping blank entries", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace", "  ", "/other"], "/Users/tester/Desktop")).toEqual([
			"/workspace",
			"/other",
		])
	})

	it("falls back to a single root when no workspace folder is open", () => {
		// Legacy-parity: an empty VS Code window must still yield a usable root
		// so @-mention file search doesn't fail with workspace_unavailable.
		expect(resolveWorkspaceManagerPaths([], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(undefined, "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(["", "   "], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
	})

	it("prefers real workspace folders over the fallback", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace"], "/Users/tester/Desktop")).toEqual(["/workspace"])
	})

	it("returns no roots when the fallback is also unavailable", () => {
		expect(resolveWorkspaceManagerPaths([], undefined)).toEqual([])
		expect(resolveWorkspaceManagerPaths([], "  ")).toEqual([])
	})
})
