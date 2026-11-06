import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SecretStorage } from "vscode"
import {
	configureGrafanaMetrics,
	grafanaSettings,
	promptGrafanaToken,
	removeGrafanaCredential,
	setGrafanaSecrets,
} from "./grafana-metrics"

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), prompt: vi.fn(), workspace: { isTrusted: true } }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => ({ getGlobalStateKey: mocks.get, setGlobalState: mocks.set }) },
}))
vi.mock("vscode", () => ({ workspace: mocks.workspace, window: { showInputBox: mocks.prompt } }))
const initial = () => ({ url: "https://grafana.example.com", dashboardUid: "machines", hostVariable: "host", panels: {} })
let saved = initial()
const values = new Map<string, string>()
beforeEach(() => {
	vi.resetAllMocks()
	values.clear()
	saved = initial()
	mocks.workspace.isTrusted = true
	mocks.get.mockImplementation(() => saved)
	mocks.set.mockImplementation((_key, value) => {
		saved = value
	})
	setGrafanaSecrets({
		onDidChange: () => ({ dispose() {} }),
		get: async (key) => values.get(key),
		store: async (key, value) => {
			values.set(key, value)
		},
		delete: async (key) => {
			values.delete(key)
		},
	} as SecretStorage)
})
describe("Grafana credentials", () => {
	it("uses a native masked prompt and never returns or persists the token in settings", async () => {
		mocks.prompt.mockResolvedValue("fixture-only-credential")
		const result = await promptGrafanaToken()
		expect(mocks.prompt).toHaveBeenCalledWith(expect.objectContaining({ password: true, ignoreFocusOut: true }))
		expect(result.hasToken).toBe(true)
		expect(JSON.stringify(result)).not.toContain("fixture-only-credential")
		expect(mocks.set).not.toHaveBeenCalled()
		expect([...values.values()]).toEqual(["fixture-only-credential"])
	})
	it("binds credentials to the full server path and keeps secrets out of new config", async () => {
		mocks.prompt.mockResolvedValue("fixture-only-credential")
		await promptGrafanaToken()
		await configureGrafanaMetrics({ ...saved, url: "https://grafana.example.com/other" })
		expect((await grafanaSettings()).hasToken).toBe(false)
		expect(JSON.stringify(saved)).not.toContain("fixture-only-credential")
	})
	it("can remove the saved token and leaves cancellation unchanged", async () => {
		mocks.prompt.mockResolvedValue("fixture-only-credential")
		await promptGrafanaToken()
		mocks.prompt.mockResolvedValue(undefined)
		await promptGrafanaToken()
		expect((await grafanaSettings()).hasToken).toBe(true)
		expect((await removeGrafanaCredential()).hasToken).toBe(false)
	})
	it("accepts a saved server before dashboard discovery and preserves token cancellation", async () => {
		await configureGrafanaMetrics({ ...initial(), dashboardUid: "" })
		mocks.prompt.mockResolvedValue(undefined)
		const cancelled = await promptGrafanaToken()
		expect(cancelled.cancelled).toBe(true)
		expect(cancelled.hasToken).toBe(false)
		mocks.prompt.mockResolvedValue("fixture-only-credential")
		expect((await promptGrafanaToken()).hasToken).toBe(true)
	})
	it("does not prompt, save or query in an untrusted workspace", async () => {
		mocks.workspace.isTrusted = false
		await expect(promptGrafanaToken()).rejects.toThrow("Trust this workspace")
		await expect(configureGrafanaMetrics(initial())).rejects.toThrow("Trust this workspace")
		expect(mocks.prompt).not.toHaveBeenCalled()
		expect(mocks.set).not.toHaveBeenCalled()
	})
})
