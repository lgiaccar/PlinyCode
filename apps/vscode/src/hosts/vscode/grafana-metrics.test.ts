import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SecretStorage } from "vscode"
import { GrafanaClient } from "@/services/grafana/client"
import {
	configureGrafanaMetrics,
	grafanaSettings,
	promptGrafanaToken,
	readGrafanaMetrics,
	removeGrafanaCredential,
	setGrafanaSecrets,
} from "./grafana-metrics"

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	set: vi.fn(),
	prompt: vi.fn(),
	warning: vi.fn(),
	workspace: { isTrusted: true },
}))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: () => ({ getGlobalStateKey: mocks.get, setGlobalState: mocks.set }) },
}))
vi.mock("vscode", () => ({
	workspace: mocks.workspace,
	window: { showInputBox: mocks.prompt, showWarningMessage: mocks.warning },
}))
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

it("keeps disk-only and detailed results in separate cache entries", async () => {
	mocks.prompt.mockResolvedValue("fixture-only-credential")
	await promptGrafanaToken()
	const metrics = vi.spyOn(GrafanaClient.prototype, "metrics").mockImplementation(async (host, _range, _now, diskOnly) => ({
		host,
		from: 0,
		to: 1,
		stepMs: 1,
		results: [{ kind: diskOnly ? "disk" : "cpu", title: "Fixture", series: [], error: "" }],
	}))
	try {
		expect((await readGrafanaMetrics("build", "24h", true)).results[0].kind).toBe("disk")
		expect((await readGrafanaMetrics("build", "24h")).results[0].kind).toBe("cpu")
		await readGrafanaMetrics("build", "24h", true)
		expect(metrics).toHaveBeenCalledTimes(3)
	} finally {
		metrics.mockRestore()
	}
})

it("coalesces in-flight disk requests, refreshes afterward, and emits a native warning", async () => {
	mocks.prompt.mockResolvedValue("fixture-only-credential")
	await promptGrafanaToken()
	let finish!: (value: import("@shared/grafana-metrics").MachineMetrics) => void
	const metrics = vi.spyOn(GrafanaClient.prototype, "metrics").mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	try {
		const first = readGrafanaMetrics("low-disk", "24h", true)
		const second = readGrafanaMetrics("low-disk", "24h", true)
		await vi.waitFor(() => expect(metrics).toHaveBeenCalledTimes(1))
		const now = Date.now()
		finish({
			host: "low-disk",
			from: now - 300_000,
			to: now,
			stepMs: 15_000,
			results: [
				{
					kind: "disk",
					title: "Disk",
					error: "",
					series: [{ name: "Free", unit: "bytes", labels: { volume: "C:" }, points: [{ time: now, value: 1e9 }] }],
				},
			],
		})
		await Promise.all([first, second])
		expect(mocks.warning).toHaveBeenCalledTimes(1)
		expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining("below 50 GB"))
	} finally {
		metrics.mockRestore()
	}
})
