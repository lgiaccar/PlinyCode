import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfiguredAgentConfigs } from "@plinycode/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	CustomizationChangeNotifier,
	type FileWatcherLike,
	setCustomizationChangeNotifier,
} from "@/core/context/instructions/user-instructions/customization-watcher"

const host = vi.hoisted(() => ({ workspacePaths: [] as string[], showMessage: vi.fn() }))
const openFileMock = vi.hoisted(() => vi.fn())
const registry = vi.hoisted(() => ({ cleanups: new Map<string, () => void>() }))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		workspace: { getWorkspacePaths: async () => ({ paths: host.workspacePaths }) },
		window: { showMessage: host.showMessage },
	},
}))
vi.mock("./openFile", () => ({ openFile: openFileMock }))
vi.mock("../grpc-handler", () => ({
	getRequestRegistry: () => ({
		registerRequest: (requestId: string, cleanup: () => void) => registry.cleanups.set(requestId, cleanup),
	}),
}))

import { createAgentFile } from "./createAgentFile"
import { refreshAgents } from "./refreshAgents"
import { subscribeToCustomizationChanges } from "./subscribeToCustomizationChanges"
import { toggleAgent } from "./toggleAgent"

function fakeController() {
	const state: Record<string, Record<string, boolean>> = { globalAgentToggles: {}, localAgentToggles: {} }
	return {
		state,
		stateManager: {
			getGlobalSettingsKey: (key: string) => state[key],
			getWorkspaceStateKey: (key: string) => state[key],
			setGlobalState: (key: string, value: Record<string, boolean>) => {
				state[key] = value
			},
			setWorkspaceState: (key: string, value: Record<string, boolean>) => {
				state[key] = value
			},
		},
	}
}

describe("Agents tab handlers", () => {
	let root: string
	let previousClineDir: string | undefined

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "agents-handlers-"))
		host.workspacePaths = [path.join(root, "repo")]
		host.showMessage.mockClear()
		openFileMock.mockClear()
		// Keep the global agents folder inside the test's own directory.
		previousClineDir = process.env.CLINE_DIR
		process.env.CLINE_DIR = path.join(root, "home", ".cline")
	})

	afterEach(() => {
		if (previousClineDir === undefined) {
			delete process.env.CLINE_DIR
		} else {
			process.env.CLINE_DIR = previousClineDir
		}
		rmSync(root, { recursive: true, force: true })
	})

	it("createAgentFile writes a template that loads as an agent, opens it and lists it", async () => {
		const controller = fakeController()
		const response = await createAgentFile(controller as never, { agentName: "Code Reviewer", isGlobal: false } as never)

		const filePath = path.join(root, "repo", ".cline", "agents", "code-reviewer.md")
		const content = readFileSync(filePath, "utf8")
		expect(content).toContain("name: code-reviewer")
		expect(content).toContain("subagent_code_reviewer")
		for (const field of ["tools", "skills", "providerId", "modelId", "maxIterations"]) {
			expect(content).toMatch(new RegExp(`^# ${field}:`, "m"))
		}
		const { configs, errors } = loadConfiguredAgentConfigs({ searchPaths: [path.dirname(filePath)] })
		expect(errors).toEqual([])
		expect(configs[0]).toMatchObject({ name: "code-reviewer", maxIterations: undefined, tools: undefined })

		expect(openFileMock).toHaveBeenCalledWith(controller, { value: filePath })
		expect(response.localAgents.map((agent) => agent.toolName)).toEqual(["subagent_code_reviewer"])
	})

	it("createAgentFile leaves an existing file alone and warns", async () => {
		const controller = fakeController()
		await createAgentFile(controller as never, { agentName: "tester", isGlobal: true } as never)
		const filePath = path.join(root, "home", ".cline", "agents", "tester.md")
		writeFileSync(filePath, "---\nname: tester\ndescription: mine\n---\nKeep me.\n")

		const response = await createAgentFile(controller as never, { agentName: "tester", isGlobal: true } as never)
		expect(readFileSync(filePath, "utf8")).toContain("Keep me.")
		expect(host.showMessage).toHaveBeenCalledTimes(1)
		expect(response.globalAgents.map((agent) => agent.description)).toEqual(["mine"])
	})

	it("toggleAgent stores the switch by path and scope and lists the agent as off", async () => {
		const controller = fakeController()
		await createAgentFile(controller as never, { agentName: "reviewer", isGlobal: false } as never)
		const filePath = path.join(root, "repo", ".cline", "agents", "reviewer.md")

		const off = await toggleAgent(controller as never, { agentPath: filePath, isGlobal: false, enabled: false } as never)
		expect(controller.state.localAgentToggles).toEqual({ [filePath]: false })
		expect(controller.state.globalAgentToggles).toEqual({})
		expect(off.localAgents[0].enabled).toBe(false)

		const listed = await refreshAgents(controller as never, {} as never)
		expect(listed.localAgents[0]).toMatchObject({ name: "reviewer", enabled: false, error: "" })
	})
})

describe("subscribeToCustomizationChanges", () => {
	afterEach(() => {
		setCustomizationChangeNotifier(undefined)
		vi.useRealTimers()
	})

	it("pushes an event after a watched file changes and stops when the panel unsubscribes", async () => {
		vi.useFakeTimers()
		const watchers: Array<FileWatcherLike & { fire: () => void; disposed: boolean }> = []
		setCustomizationChangeNotifier(
			new CustomizationChangeNotifier({
				createWatcher: () => {
					const listeners: Array<() => void> = []
					const watcher = {
						disposed: false,
						onDidCreate: (listener: () => void) => listeners.push(listener),
						onDidChange: (listener: () => void) => listeners.push(listener),
						onDidDelete: (listener: () => void) => listeners.push(listener),
						fire: () => {
							for (const listener of listeners) listener()
						},
						dispose: () => {
							watcher.disposed = true
						},
					}
					watchers.push(watcher)
					return watcher
				},
				getTargets: () => [{ base: "/repo", pattern: "**" }],
				debounceMs: 50,
			}),
		)
		const responseStream = vi.fn(async () => {})

		await subscribeToCustomizationChanges({} as never, {} as never, responseStream, "req-1")
		await vi.advanceTimersByTimeAsync(0)
		watchers[0].fire()
		await vi.advanceTimersByTimeAsync(60)
		expect(responseStream).toHaveBeenCalledTimes(1)
		expect(responseStream).toHaveBeenCalledWith({}, false)

		registry.cleanups.get("req-1")?.()
		expect(watchers[0].disposed).toBe(true)
	})
})
