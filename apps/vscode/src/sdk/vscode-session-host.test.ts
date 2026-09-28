import type { ClineCoreStartInput } from "@plinycode/core"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockClineCoreCreate = vi.hoisted(() => vi.fn())
const mockCreateVscodeExtraTools = vi.hoisted(() => vi.fn(async () => []))

vi.mock("@plinycode/core", async () => {
	const actual = await vi.importActual<typeof import("@plinycode/core")>("@plinycode/core")
	return {
		...actual,
		ClineCore: {
			create: mockClineCoreCreate,
		},
	}
})

vi.mock("@/services/logging/distinctId", () => ({
	getDistinctId: () => "distinct-id",
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalStateKey: () => undefined,
		}),
	},
}))

vi.mock("./vscode-runtime-builder", () => ({
	createVscodeExtraTools: mockCreateVscodeExtraTools,
}))

import { VscodeSessionHost } from "./vscode-session-host"

describe("VscodeSessionHost", () => {
	beforeEach(() => {
		mockClineCoreCreate.mockReset()
		mockClineCoreCreate.mockResolvedValue({ runtimeAddress: undefined })
		mockCreateVscodeExtraTools.mockReset().mockResolvedValue([])
	})

	it("marks sessions as started from vscode", async () => {
		await VscodeSessionHost.create({
			// biome-ignore lint/suspicious/noExplicitAny: focused host unit test
			mcpHub: {} as any,
		})

		const prepare = mockClineCoreCreate.mock.calls[0][0].prepare
		const bootstrap = await prepare()
		const prepared = await bootstrap.applyToStartSessionInput({
			source: undefined,
			config: {
				cwd: "/tmp/workspace",
				extraTools: [],
			},
		})

		expect(prepared.source).toBe("vscode")
	})

	it("passes custom editor and apply_patch executors into tool executor capabilities", async () => {
		const editorExecutor = vi.fn()
		const applyPatchExecutor = vi.fn()
		await VscodeSessionHost.create({
			// biome-ignore lint/suspicious/noExplicitAny: focused host unit test
			mcpHub: {} as any,
			editorExecutor,
			applyPatchExecutor,
		})

		const capabilities = mockClineCoreCreate.mock.calls[0][0].capabilities
		expect(capabilities.toolExecutors.editor).toBe(editorExecutor)
		expect(capabilities.toolExecutors.applyPatch).toBe(applyPatchExecutor)
	})

	it("leaves the SDK's default edit executors in place when no overrides are provided", async () => {
		await VscodeSessionHost.create({
			// biome-ignore lint/suspicious/noExplicitAny: focused host unit test
			mcpHub: {} as any,
		})

		const capabilities = mockClineCoreCreate.mock.calls[0][0].capabilities
		expect(capabilities.toolExecutors).toBeUndefined()
	})

	it("appends VS Code extra tools after the tools already in the start input", async () => {
		mockCreateVscodeExtraTools.mockResolvedValueOnce([{ name: "vscode-tool" }] as never)
		await VscodeSessionHost.create({
			// biome-ignore lint/suspicious/noExplicitAny: focused host unit test
			mcpHub: {} as any,
		})

		const prepare = mockClineCoreCreate.mock.calls[0][0].prepare
		const bootstrap = await prepare()
		const result = await bootstrap.applyToStartSessionInput({
			config: { cwd: "/workspace", extraTools: [{ name: "input-tool" }] },
		} as never)

		expect(mockCreateVscodeExtraTools).toHaveBeenCalledWith({} as never, {
			cwd: "/workspace",
			getTerminalManager: undefined,
			vscodeTerminalExecutionMode: undefined,
		})
		expect(result.source).toBe("vscode")
		expect(result.config.extraTools).toEqual([{ name: "input-tool" }, { name: "vscode-tool" }])
	})

	it("prepares the start input of a checkpoint restore with a replacement session", async () => {
		const innerRestore = vi.fn(async (_input: unknown) => ({ checkpoint: {} }))
		mockClineCoreCreate.mockResolvedValue({ runtimeAddress: undefined, restore: innerRestore })
		const host = await VscodeSessionHost.create({
			// biome-ignore lint/suspicious/noExplicitAny: focused host unit test
			mcpHub: {} as any,
		})

		await host.restore({
			sessionId: "session-1",
			checkpointRunCount: 1,
			start: { config: { cwd: "/workspace", extraTools: [] } } as never,
		})

		// ClineCore.restore does not run the prepare hook, so the host must apply it itself.
		const restoredInput = innerRestore.mock.calls[0][0] as { start: ClineCoreStartInput }
		expect(restoredInput.start.source).toBe("vscode")
	})

	it("passes a workspace-only restore that starts no replacement session through unchanged", async () => {
		const innerRestore = vi.fn(async () => ({ checkpoint: {} }))
		mockClineCoreCreate.mockResolvedValue({ runtimeAddress: undefined, restore: innerRestore })
		const host = await VscodeSessionHost.create({
			// biome-ignore lint/suspicious/noExplicitAny: focused host unit test
			mcpHub: {} as any,
		})

		await host.restore({ sessionId: "session-1", checkpointRunCount: 1 })

		expect(mockCreateVscodeExtraTools).not.toHaveBeenCalled()
		expect(innerRestore).toHaveBeenCalledWith({ sessionId: "session-1", checkpointRunCount: 1 })
	})
})
