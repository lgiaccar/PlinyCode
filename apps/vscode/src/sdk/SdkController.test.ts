import { describe, expect, it, vi } from "vitest"
import { telemetryService } from "@/services/telemetry"
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

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureRemoteConfigSessionGate: vi.fn(),
		captureEditMessageRestart: vi.fn(),
	},
}))

const { buildBaseStateMock } = vi.hoisted(() => ({
	buildBaseStateMock: vi.fn(async () => ({ taskHistory: [] })),
}))
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({
	getStateToPostToWebview: buildBaseStateMock,
}))

describe("SDK remote-config coordination", () => {
	it("posts the current remote-config revision to the webview", async () => {
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: true,
			currentRemoteConfigRevision: 7,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: { listHistory: async () => [] },
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
		}

		await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledWith(
			expect.objectContaining({ isRemoteConfigAvailable: true, currentRemoteConfigRevision: 7 }),
		)
	})

	it("keys refreshes by the current user and organization", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({ user: { uid: "user-1" } }),
				getActiveOrganizationId: () => "org-1",
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("user-1:org-1", {})
	})

	it("uses a stable signed-out identity so startup refresh can settle", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({}),
				getActiveOrganizationId: () => null,
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("signed-out:no-org", {})
	})

	it("refreshes remote config after login before posting authenticated state", async () => {
		const events: string[] = []
		const controller = {
			authService: { handleAuthCallback: vi.fn(async () => events.push("auth")) },
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.handleAuthCallback.call(controller as never, "token", "cline")

		expect(events).toEqual(["auth", "refresh", "post"])
	})

	it("rematerializes policy and ends the active session after a managed toggle", async () => {
		const events: string[] = []
		const controller = {
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			sessions: {
				endActiveSession: vi.fn(async () => {
					events.push("end")
				}),
			},
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.rematerializeRemoteConfig.call(controller as never)

		expect(events).toEqual(["refresh", "end", "post"])
		expect(controller.sessions.endActiveSession).toHaveBeenCalledWith("remoteConfigToggle", { awaitStop: true })
	})

	it("allows the current organization to start with its last known-good policy after a transient failure", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => "org-current" },
			remoteConfigBundle: { metadata: { organizationId: "org-current" } },
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "last_known_good", managed: true }),
		)
	})

	it("does not block session start for users without an active organization when refresh fails", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => undefined },
			remoteConfigBundle: undefined,
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unmanaged", managed: false }),
		)
	})

	it("does not block unmanaged session start when the refresh rejects instead of returning false", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => undefined },
			remoteConfigBundle: undefined,
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unmanaged", managed: false }),
		)
	})

	it("blocks session start when the install was managed but the identity cannot be resolved", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => "org-previous" },
			remoteConfigBundle: undefined,
		}

		await expect(SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never)).rejects.toThrow(
			"Could not verify organization policy",
		)
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "blocked", managed: true }),
		)
	})

	it("blocks session start when current organization policy cannot be verified", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => "org-new" },
			remoteConfigBundle: { metadata: { organizationId: "org-old" } },
		}

		await expect(SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never)).rejects.toThrow(
			"Could not verify organization policy",
		)
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "blocked", managed: true }),
		)
	})

	it("does not enter task startup until initial remote config is ready", async () => {
		let finishPolicyCheck!: () => void
		const policyReady = new Promise<void>((resolve) => {
			finishPolicyCheck = resolve
		})
		const events: string[] = []
		const initTask = vi.fn(async () => {
			events.push("task")
			return "task-id"
		})
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => {
				await policyReady
				events.push("policy")
			}),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { initTask },
		}

		const taskPromise = SdkController.prototype.initTask.call(controller as never, "start immediately")
		await Promise.resolve()
		expect(initTask).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()

		finishPolicyCheck()
		const taskId = await taskPromise

		expect(taskId).toBe("task-id")
		expect(events).toEqual(["policy", "task"])
		expect(initTask).toHaveBeenCalledWith("start immediately", undefined, undefined, undefined, undefined)
	})

	it("waits for initial remote config before resuming an existing task", async () => {
		const events: string[] = []
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => events.push("policy")),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { reinitExistingTaskFromId: vi.fn(async () => events.push("resume")) },
		}

		await SdkController.prototype.reinitExistingTaskFromId.call(controller as never, "task-id")

		expect(events).toEqual(["policy", "resume"])
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
