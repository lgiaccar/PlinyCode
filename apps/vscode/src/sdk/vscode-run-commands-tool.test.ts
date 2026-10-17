import { CommandAbortedError, CommandExitError, type ShellExecutor } from "@plinycode/core"
import type { AgentToolContext } from "@plinycode/shared"
import { EventEmitter } from "events"
import * as fs from "fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import type { TerminalCompletionDetails } from "@/integrations/terminal/types"
import { ProcessRegistry } from "./processes/process-registry"
import { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import {
	BACKGROUND_EXEC_TIMEOUT_MS,
	createVscodeRunCommandsTool,
	executeForeground,
	FOREGROUND_COMMAND_AUTO_PROCEED_MS,
	formatCommandForTerminal,
	PROCEED_LOG_MAX_BYTES,
} from "./vscode-run-commands-tool"

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn<(path: fs.PathLike) => boolean>(),
	getGlobalSettingsKey: vi.fn(() => "default"),
	showMessage: vi.fn(async () => ({})),
	/** Replaces the engine's spawning executor when set (background processes). */
	fakeShellExecutor: undefined as ShellExecutor | undefined,
	/** The options each spawning executor was created with. */
	shellExecutorOptions: [] as unknown[],
	terminalLocation: "panel" as "panel" | "editor",
	setTerminalLocation: vi.fn(async () => {}),
	disableNarrowTerminalWarning: vi.fn(async () => {}),
}))

vi.mock("@/hosts/vscode/terminal/terminal-location", () => ({
	readTerminalLocation: () => mocks.terminalLocation,
	setTerminalLocation: mocks.setTerminalLocation,
	isNarrowTerminalWarningEnabled: () => true,
	disableNarrowTerminalWarning: mocks.disableNarrowTerminalWarning,
}))

vi.mock("@plinycode/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@plinycode/core")>()
	return {
		...actual,
		createShellExecutor: (...args: Parameters<typeof actual.createShellExecutor>) => {
			mocks.shellExecutorOptions.push(args[0])
			return mocks.fakeShellExecutor ?? actual.createShellExecutor(...args)
		},
	}
})

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { window: { showMessage: mocks.showMessage } },
}))

vi.mock("fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs")>()),
	existsSync: mocks.existsSync,
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({ getGlobalSettingsKey: mocks.getGlobalSettingsKey }),
	},
}))

const originalPlatform = process.platform
const originalEnv = { ...process.env }
const originalGetConfiguration = vscode.workspace.getConfiguration

afterEach(() => {
	vi.useRealTimers()
	Object.defineProperty(process, "platform", { value: originalPlatform })
	process.env = { ...originalEnv }
	vscode.workspace.getConfiguration = originalGetConfiguration
	mocks.existsSync.mockReset()
	mocks.getGlobalSettingsKey.mockReset()
	mocks.getGlobalSettingsKey.mockReturnValue("default")
	mocks.fakeShellExecutor = undefined
	mocks.shellExecutorOptions = []
	mocks.terminalLocation = "panel"
})

describe("createVscodeRunCommandsTool", () => {
	it("uses the VS Code terminal when the execution mode is omitted", async () => {
		const process = createFakeTerminalProcess({ lines: ["terminal-default-ok"] })
		const getTerminalManager = vi.fn(() => createFakeTerminalManager(process))
		const tool = createVscodeRunCommandsTool({ cwd: "/workspace", getTerminalManager })

		const results = await tool.execute(
			{ commands: ["printf 'terminal-default-ok\\n'"] },
			{ agentId: "agent-1", conversationId: "conversation-1", iteration: 1 },
		)

		expect(getTerminalManager).toHaveBeenCalledOnce()
		expect(results).toEqual([expect.objectContaining({ result: "terminal-default-ok", success: true })])
	})

	it("tells the model to run long jobs in the foreground, in the terminal mode only", () => {
		const options = { cwd: "/workspace", getTerminalManager: () => createFakeTerminalManager(createFakeTerminalProcess({})) }
		expect(createVscodeRunCommandsTool(options).description).toContain("still running after 5 minutes")
		expect(
			createVscodeRunCommandsTool({ ...options, vscodeTerminalExecutionMode: "backgroundExec" }).description,
		).not.toContain("still running after 5 minutes")
	})

	it("notes a narrow terminal to the model, and warns the user once per terminal location with a way out", async () => {
		const run = async (columns: number, location?: "panel" | "editor") => {
			const process = createFakeTerminalProcess({
				lines: ["RUN_DIR=D:/dev0/GPUSurfer/ai_output/surfer_target_cases/20261006_124919"],
				completionDetails: { exitCode: 0, terminalColumns: columns },
			})
			const tool = createVscodeRunCommandsTool({
				cwd: "/workspace",
				getTerminalManager: () => createFakeTerminalManager(process, location),
			})
			const [result] = (await tool.execute(
				{ commands: ["Get-ChildItem"] },
				{ agentId: "agent-1", conversationId: "conversation-1", iteration: 1 },
			)) as Array<{ result: string }>
			return result.result
		}
		expect(await run(120)).not.toContain("columns wide")
		expect(mocks.showMessage).not.toHaveBeenCalled()
		mocks.showMessage.mockResolvedValueOnce({ selectedOption: "Open Terminals in Editor Area" } as never)
		expect(await run(33)).toContain("[The terminal is only 33 columns wide.")
		expect(await run(33)).toContain("Out-String -Width 300")
		expect(mocks.showMessage).toHaveBeenCalledOnce()
		expect(mocks.showMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				message: expect.stringContaining("Open PlinyCode's terminals in the editor area"),
				options: { items: ["Open Terminals in Editor Area", "Don't Show Again"] },
			}),
		)
		await vi.waitFor(() => expect(mocks.setTerminalLocation).toHaveBeenCalledWith("editor"))

		// Still narrow in the editor area: a warning of its own, which cannot suggest the editor area again.
		mocks.showMessage.mockResolvedValueOnce({ selectedOption: "Don't Show Again" } as never)
		expect(await run(54, "editor")).toContain("[The terminal is only 54 columns wide.")
		expect(mocks.showMessage).toHaveBeenCalledTimes(2)
		expect(mocks.showMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				message: expect.stringContaining("Widen the editor group"),
				options: { items: ["Don't Show Again"] },
			}),
		)
		await vi.waitFor(() => expect(mocks.disableNarrowTerminalWarning).toHaveBeenCalled())
	})

	it("opens a foreground session's terminal where plinycode.terminal.location says", async () => {
		mocks.terminalLocation = "editor"
		const getOrCreateTerminal = vi.fn(async () => ({ terminal: { show: () => {} } }) as never)
		const tool = createVscodeRunCommandsTool({
			cwd: "/workspace",
			getTerminalManager: () =>
				({ getOrCreateTerminal, runCommand: () => createFakeTerminalProcess({}) }) as unknown as VscodeTerminalManager,
		})
		await tool.execute({ commands: ["echo hi"] }, { agentId: "agent-1", conversationId: "conversation-1", iteration: 1 })
		expect(getOrCreateTerminal).toHaveBeenCalledWith("/workspace", "default", "editor")
	})

	it("gives Background Exec the tool's limit and the terminal's environment with a wide COLUMNS", async () => {
		mocks.fakeShellExecutor = async () => "done"
		const tool = createVscodeRunCommandsTool({
			cwd: "/workspace",
			getTerminalManager: () => createFakeTerminalManager(createFakeTerminalProcess({})),
			vscodeTerminalExecutionMode: "backgroundExec",
			bashTimeoutMs: BACKGROUND_EXEC_TIMEOUT_MS,
		})
		expect(tool.description).toContain("A command still running after 10 minutes is stopped.")
		await tool.execute({ commands: ["echo hi"] }, { agentId: "agent-1", conversationId: "conversation-1", iteration: 1 })
		expect(mocks.shellExecutorOptions).toEqual([
			expect.objectContaining({
				timeoutMs: BACKGROUND_EXEC_TIMEOUT_MS,
				env: expect.objectContaining({ COLUMNS: "200", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" }),
			}),
		])
	})

	it("constructs a cmd tool from the stock array-valued Command Prompt profile", () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		process.env.windir = "C:\\Windows"
		mocks.existsSync.mockImplementation((candidate) => candidate === "C:\\Windows\\System32\\cmd.exe")
		vscode.workspace.getConfiguration = () =>
			({
				get: (key: string) => {
					if (key === "defaultProfile.windows") {
						return "Command Prompt"
					}
					if (key === "profiles.windows") {
						return {
							"Command Prompt": {
								path: [`\${env:windir}\\Sysnative\\cmd.exe`, `\${env:windir}\\System32\\cmd.exe`],
							},
						}
					}
					return undefined
				},
			}) as never

		const tool = createVscodeRunCommandsTool({
			cwd: "C:\\workspace",
			getTerminalManager: () => {
				throw new Error("Terminal manager should not be created during tool construction")
			},
			vscodeTerminalExecutionMode: "vscodeTerminal",
		})

		expect(tool.name).toBe("run_commands")
		expect(tool.description).toContain("Commands run through cmd.exe")
	})

	it("re-derives the description from the current profile on each read", () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		mocks.existsSync.mockReturnValue(true)
		mocks.getGlobalSettingsKey.mockReturnValue("cmd")

		const tool = createVscodeRunCommandsTool({
			cwd: "C:\\workspace",
			getTerminalManager: () => {
				throw new Error("Terminal manager should not be created during tool construction")
			},
			vscodeTerminalExecutionMode: "vscodeTerminal",
		})
		expect(tool.description).toContain("Commands run through cmd.exe")

		// A profile change takes effect at the next description read (the
		// model-request boundary), without a session rebuild.
		mocks.getGlobalSettingsKey.mockReturnValue("powershell-7")
		expect(tool.description).toContain("PowerShell (pwsh.exe)")
		expect(tool.description).not.toMatch(/PowerShell (?:Core|\d)/)
		expect(tool.description).toContain("quote paths and arguments for pwsh.exe")
		expect(tool.description).toContain("another pwsh.exe -Command invocation")

		mocks.getGlobalSettingsKey.mockReturnValue("powershell-legacy")
		expect(tool.description).toContain("Windows PowerShell (powershell.exe)")
		expect(tool.description).toContain("quote paths and arguments for powershell.exe")
		expect(tool.description).toContain("another powershell.exe -Command invocation")
	})

	it("keeps the prompted PowerShell edition until the next model request", async () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		mocks.existsSync.mockReturnValue(true)
		mocks.getGlobalSettingsKey.mockReturnValue("powershell-legacy")
		const manager = createFakeTerminalManager(createFakeTerminalProcess({ lines: ["ok"] }))
		const getOrCreateTerminal = vi.spyOn(manager, "getOrCreateTerminal")
		const tool = createVscodeRunCommandsTool({ cwd: "C:\\workspace", getTerminalManager: () => manager })
		const legacyDescription = tool.description
		expect(legacyDescription).toContain("Windows PowerShell (powershell.exe)")

		mocks.getGlobalSettingsKey.mockReturnValue("powershell-7")
		await tool.execute(
			{ commands: ["Write-Output 'ok'"] },
			{ agentId: "agent-1", conversationId: "conversation-1", iteration: 1 },
		)
		expect(getOrCreateTerminal).toHaveBeenLastCalledWith("C:\\workspace", "powershell-legacy", "panel")

		const nextDescription = tool.description
		expect(nextDescription).toContain("PowerShell (pwsh.exe)")
		expect(nextDescription).not.toBe(legacyDescription)
		expect(tool.description).toBe(nextDescription)
		manager.runCommand = () => createFakeTerminalProcess({ lines: ["ok"] })
		await tool.execute(
			{ commands: ["Write-Output 'ok'"] },
			{ agentId: "agent-1", conversationId: "conversation-1", iteration: 2 },
		)
		expect(getOrCreateTerminal).toHaveBeenLastCalledWith("C:\\workspace", "powershell-7", "panel")
	})
})

/**
 * Minimal fake of the process object returned by VscodeTerminalManager.runCommand():
 * an EventEmitter that is also awaitable (mirroring mergePromise in
 * VscodeTerminalProcess.ts), emitting the given lines then completing.
 */
function createFakeTerminalProcess(options: { lines?: string[]; completionDetails?: TerminalCompletionDetails } = {}) {
	const emitter = new EventEmitter()
	let resolvePromise!: () => void
	// Emit on a macrotask (not a microtask) so executeForeground's
	// `await terminalManager.getOrCreateTerminal(cwd)` and subsequent
	// `process.on("line", ...)` registration are guaranteed to run first,
	// matching the ordering a real terminal process provides.
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
		setTimeout(() => {
			for (const line of options.lines ?? []) {
				emitter.emit("line", line)
			}
			emitter.emit("completed", options.completionDetails)
			emitter.emit("continue")
			resolve()
		}, 0)
	})
	const fakeProcess = Object.assign(emitter, {
		then: promise.then.bind(promise),
		catch: promise.catch.bind(promise),
		finally: promise.finally.bind(promise),
		getCompletionDetails: () => options.completionDetails ?? {},
		detach: () => {
			emitter.emit("continue")
			resolvePromise()
		},
	})
	return fakeProcess as unknown as ReturnType<VscodeTerminalManager["runCommand"]>
}

function createRejectedTerminalProcess(error: Error) {
	const emitter = new EventEmitter()
	const promise = new Promise<void>((_resolve, reject) => setTimeout(() => reject(error), 0))
	const fakeProcess = Object.assign(emitter, {
		then: promise.then.bind(promise),
		catch: promise.catch.bind(promise),
		finally: promise.finally.bind(promise),
		getCompletionDetails: () => ({}),
	})
	return fakeProcess as unknown as ReturnType<VscodeTerminalManager["runCommand"]>
}

function createFakeTerminalManager(
	process: ReturnType<VscodeTerminalManager["runCommand"]>,
	location?: "panel" | "editor",
): VscodeTerminalManager {
	return {
		getOrCreateTerminal: async () => ({ terminal: { show: () => {} }, location }) as never,
		runCommand: () => process,
	} as unknown as VscodeTerminalManager
}

/**
 * A controllable fake terminal process for detach tests: the caller decides
 * when lines are emitted and when the command completes. Mirrors the real
 * VscodeTerminalProcess contract: detach() resolves the awaited promise while
 * 'line'/'completed' events keep flowing.
 */
function createControllableTerminalProcess() {
	const emitter = new EventEmitter()
	let resolvePromise!: () => void
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
	})
	const fakeProcess = Object.assign(emitter, {
		then: promise.then.bind(promise),
		catch: promise.catch.bind(promise),
		finally: promise.finally.bind(promise),
		getCompletionDetails: () => ({}),
		detach: () => {
			emitter.emit("continue")
			resolvePromise()
		},
		continue: () => {
			// Mirror VscodeTerminalProcess.continue(): stop observing and resolve.
			emitter.removeAllListeners("line")
			emitter.emit("continue")
			resolvePromise()
		},
	})
	return {
		process: fakeProcess as unknown as ReturnType<VscodeTerminalManager["runCommand"]>,
		emitLine: (line: string) => emitter.emit("line", line),
		complete: (details?: TerminalCompletionDetails) => {
			emitter.emit("completed", details)
			emitter.emit("continue")
			resolvePromise()
		},
		fail: (error: Error) => emitter.emit("error", error),
	}
}

function createControllableUnobservedTerminalProcess() {
	const controlled = createControllableTerminalProcess()
	return {
		...controlled,
		completeUnobserved: () => controlled.complete({ unobservedCommand: { source: "sendText", ownership: "detached" } }),
	}
}

/** Poll until the predicate holds, for asserting on async log-file writes. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now()
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out")
		}
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

describe("formatCommandForTerminal", () => {
	it.each([
		{
			name: "raw shell command",
			input: "which git",
			expected: "which git",
		},
		{
			name: "raw shell command with pipes and quotes",
			input: "git status --short | sed -n '1,20p'",
			expected: "git status --short | sed -n '1,20p'",
		},
		{
			name: "structured command with omitted args",
			input: { command: "which git" },
			expected: "which git",
		},
		{
			name: "structured shell command with omitted args and metacharacters",
			input: { command: "git status --short | head -20" },
			expected: "git status --short | head -20",
		},
		{
			name: "structured executable with explicit empty args",
			input: { command: "/tmp/path with spaces/tool", args: [] },
			expected: "'/tmp/path with spaces/tool'",
		},
		{
			name: "structured executable with simple args",
			input: { command: "which", args: ["git"] },
			expected: "which git",
		},
		{
			name: "structured executable with spaced args",
			input: { command: "echo", args: ["hello world", "again"] },
			expected: "echo 'hello world' again",
		},
		{
			name: "structured executable with apostrophe args",
			input: { command: "printf", args: ["it's ok"] },
			expected: "printf 'it'\\''s ok'",
		},
		{
			name: "structured executable with empty arg",
			input: { command: "printf", args: [""] },
			expected: "printf ''",
		},
		{
			name: "structured executable with shell metacharacters in args",
			input: { command: "echo", args: ["$HOME", "a&b", "semi;colon", "paren(value)"] },
			expected: "echo '$HOME' 'a&b' 'semi;colon' 'paren(value)'",
		},
		{
			name: "structured executable with quoted args",
			input: { command: "node", args: ["-e", 'console.log("hi")'] },
			expected: "node -e 'console.log(\"hi\")'",
		},
	])("$name", ({ input, expected }) => {
		expect(formatCommandForTerminal(input)).toBe(expected)
	})

	it("quotes multiple structured args that need shell escaping", () => {
		expect(formatCommandForTerminal({ command: "echo", args: ["hello world", "it's ok"] })).toBe(
			"echo 'hello world' 'it'\\''s ok'",
		)
	})
})

describe("executeForeground", () => {
	it("returns output as-is on success (no exit code captured)", async () => {
		const process = createFakeTerminalProcess({ lines: ["hello"] })
		const terminalManager = createFakeTerminalManager(process)

		const result = await executeForeground("echo hello", "/workspace", terminalManager, 1000)

		expect(result).toBe("hello")
	})

	it("returns output as-is when the exit code is 0", async () => {
		const process = createFakeTerminalProcess({ lines: ["hello"], completionDetails: { exitCode: 0 } })
		const terminalManager = createFakeTerminalManager(process)

		const result = await executeForeground("echo hello", "/workspace", terminalManager, 1000)

		expect(result).toBe("hello")
	})

	it("passes the caller's terminal profile through to getOrCreateTerminal", async () => {
		const process = createFakeTerminalProcess({ lines: ["ok"] })
		const getOrCreateTerminal = vi.fn(async () => ({ terminal: { show: () => {} } }) as never)
		const terminalManager = {
			getOrCreateTerminal,
			runCommand: () => process,
		} as unknown as VscodeTerminalManager

		await executeForeground("echo ok", "/workspace", terminalManager, 1000, undefined, undefined, "wsl-bash")

		expect(getOrCreateTerminal).toHaveBeenCalledWith("/workspace", "wsl-bash", "panel")
	})

	it("throws CommandExitError with the exit code on non-zero exit", async () => {
		const terminalManager = createFakeTerminalManager(
			createFakeTerminalProcess({ lines: ["boom"], completionDetails: { exitCode: 127 } }),
		)

		try {
			await executeForeground("nonexistent-cmd", "/workspace", terminalManager, 1000)
			expect.unreachable("expected executeForeground to throw")
		} catch (error) {
			expect(error).toBeInstanceOf(CommandExitError)
			expect((error as InstanceType<typeof CommandExitError>).exitCode).toBe(127)
			expect((error as InstanceType<typeof CommandExitError>).output).toContain("boom")
		}
	})

	it("caps buffered output lines instead of accumulating without bound", async () => {
		// One more line than the cap — the earliest line must be dropped rather
		// than growing the buffer indefinitely.
		const manyLines = Array.from({ length: 10_001 }, (_, i) => `line-${i}`)
		const terminalManager = createFakeTerminalManager(createFakeTerminalProcess({ lines: manyLines }))

		const result = await executeForeground("noisy-cmd", "/workspace", terminalManager, 10_000_000)

		expect(result).not.toContain("line-0\n")
		expect(result).toContain("line-10000")
		expect(result).toContain("dropped")
	})

	it("throws CommandExitError when the terminal closes mid-command, even with no exit code", async () => {
		const process = createFakeTerminalProcess({
			lines: ["partial output"],
			completionDetails: { terminalClosed: true },
		})
		const terminalManager = createFakeTerminalManager(process)

		try {
			await executeForeground("long-running-cmd", "/workspace", terminalManager, 1000)
			expect.unreachable("expected executeForeground to throw when the terminal closed mid-command")
		} catch (error) {
			expect(error).toBeInstanceOf(CommandExitError)
			expect((error as InstanceType<typeof CommandExitError>).output).toContain("Terminal closed")
		}
	})

	it("reports a command interrupted while waiting for keyboard input as a failure with the question", async () => {
		const process = createFakeTerminalProcess({
			lines: ["Deleting build/", "Are you sure? [y/N]"],
			completionDetails: { exitCode: 0, awaitingInput: "Are you sure? [y/N]" },
		})
		const terminalManager = createFakeTerminalManager(process)

		try {
			await executeForeground("clean --interactive", "/workspace", terminalManager, 1000)
			expect.unreachable("expected executeForeground to fail a command that waited for input")
		} catch (error) {
			expect(error).toBeInstanceOf(CommandExitError)
			const exit = error as InstanceType<typeof CommandExitError>
			expect(exit.exitCode).toBe(1)
			expect(exit.output).toContain('waited for keyboard input (its last line was "Are you sure? [y/N]")')
			expect(exit.output).toContain("Rerun it non-interactively")
			expect(exit.output).toContain("Deleting build/")
		}
	})

	it("throws an indeterminate CommandExitError when command completion cannot be observed", async () => {
		const process = createFakeTerminalProcess({
			lines: ["partial output"],
			completionDetails: { unobservedCommand: { source: "sendText", ownership: "managed" } },
		})
		const terminalManager = createFakeTerminalManager(process)

		try {
			await executeForeground("long-running-cmd", "/workspace", terminalManager, 1000)
			expect.unreachable("expected executeForeground to reject indeterminate completion")
		} catch (error) {
			expect(error).toBeInstanceOf(CommandExitError)
			expect((error as InstanceType<typeof CommandExitError>).output).toContain("must not be assumed to have succeeded")
			expect((error as InstanceType<typeof CommandExitError>).output).toContain(
				"The terminal remains open for now, but starting another foreground command will attempt to close it",
			)
			expect((error as InstanceType<typeof CommandExitError>).output).toContain("partial output")
		}
	})

	it("says markerless terminals will be preserved when completion cannot be observed", async () => {
		const process = createFakeTerminalProcess({
			completionDetails: {
				unobservedCommand: { source: "markerlessShellIntegration", ownership: "managed" },
			},
		})

		try {
			await executeForeground("remote-command", "/workspace", createFakeTerminalManager(process), 1000)
			expect.unreachable("expected executeForeground to reject indeterminate completion")
		} catch (error) {
			expect(error).toBeInstanceOf(CommandExitError)
			expect((error as InstanceType<typeof CommandExitError>).output).toContain(
				"left open and will not be closed automatically",
			)
			expect((error as InstanceType<typeof CommandExitError>).output).not.toContain("next foreground command")
		}
	})

	it("unregisters its foreground handle when the command completes normally", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const terminalManager = createFakeTerminalManager(createFakeTerminalProcess({ lines: ["hello"] }))

		const result = await executeForeground("echo hello", "/workspace", terminalManager, 1000, undefined, coordinator)

		expect(result).toBe("hello")
		expect(coordinator.isRunning).toBe(false)
	})

	it("removes per-call listeners when the command completes", async () => {
		const process = createFakeTerminalProcess({ lines: ["hello"] })

		await executeForeground("echo hello", "/workspace", createFakeTerminalManager(process), 1000)

		expect(process.listenerCount("line")).toBe(0)
	})

	it("removes per-call and abort listeners when the command rejects", async () => {
		const process = createRejectedTerminalProcess(new Error("stream failed"))
		const abortController = new AbortController()
		const removeAbortListener = vi.spyOn(abortController.signal, "removeEventListener")

		await expect(
			executeForeground("failing-command", "/workspace", createFakeTerminalManager(process), 1000, abortController.signal),
		).rejects.toThrow("stream failed")

		expect(process.listenerCount("line")).toBe(0)
		expect(process.listenerCount("completed")).toBe(0)
		expect(process.listenerCount("continue")).toBe(0)
		expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function))
	})

	it("interrupts the running command in the terminal when the task is aborted", async () => {
		const { process, emitLine } = createControllableTerminalProcess()
		const sendInterrupt = vi.fn()
		const terminalManager = {
			getOrCreateTerminal: async () => ({ terminal: { show: () => {} } }) as never,
			runCommand: () => process,
			sendInterrupt,
		} as unknown as VscodeTerminalManager
		const abortController = new AbortController()

		const resultPromise = executeForeground("sleep 300", "/workspace", terminalManager, 1000, abortController.signal)

		// Wait until the command has actually started (line listeners attached).
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("still running")

		abortController.abort()

		await expect(resultPromise).rejects.toThrow("Command execution aborted")
		// The command must be interrupted (Ctrl+C), not merely left running.
		expect(sendInterrupt).toHaveBeenCalledTimes(1)
		// And observation stops afterward.
		expect(process.listenerCount("line")).toBe(0)
	})

	it("still cancels the task if interrupting the terminal throws", async () => {
		const { process } = createControllableTerminalProcess()
		const terminalManager = {
			getOrCreateTerminal: async () => ({ terminal: { show: () => {} } }) as never,
			runCommand: () => process,
			sendInterrupt: () => {
				throw new Error("terminal already disposed")
			},
		} as unknown as VscodeTerminalManager
		const abortController = new AbortController()

		const resultPromise = executeForeground("sleep 300", "/workspace", terminalManager, 1000, abortController.signal)

		await waitFor(() => process.listenerCount("line") > 0)
		abortController.abort()

		await expect(resultPromise).rejects.toThrow("Command execution aborted")
	})

	it("names the command, cwd and cause and keeps partial output when aborted", async () => {
		const { process, emitLine } = createControllableTerminalProcess()
		const terminalManager = {
			getOrCreateTerminal: async () => ({ terminal: { show: () => {} } }) as never,
			runCommand: () => process,
			sendInterrupt: vi.fn(),
		} as unknown as VscodeTerminalManager
		const abortController = new AbortController()

		const resultPromise = executeForeground("npm test", "/workspace", terminalManager, 1000, abortController.signal)
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("partial line")
		abortController.abort(new Error("user_cancel"))

		const error = await resultPromise.then(
			() => undefined,
			(e: unknown) => e,
		)
		expect(error).toBeInstanceOf(CommandAbortedError)
		const aborted = error as CommandAbortedError
		expect(aborted.message).toBe("Command execution aborted (cancelled by user): `npm test` in /workspace")
		expect(aborted.output).toContain("partial line")
	})
})

describe("executeForeground — Proceed While Running", () => {
	it("automatically proceeds after 300 seconds instead of blocking the agent turn", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, complete } = createControllableTerminalProcess()
		const resultPromise = executeForeground(
			"devserver",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			undefined,
			coordinator,
		)

		// Let terminal acquisition finish and output listeners attach without
		// advancing the auto-proceed clock.
		await new Promise<void>((resolve) => setImmediate(resolve))
		emitLine("listening on :3000")

		let settled = false
		void resultPromise.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(FOREGROUND_COMMAND_AUTO_PROCEED_MS - 1)
		expect(settled).toBe(false)

		await vi.advanceTimersByTimeAsync(1)
		const result = await resultPromise
		expect(result).toContain("automatically proceeded")
		expect(result).toContain("after 300 seconds")
		expect(result).not.toContain("The user chose")
		expect(result).toContain("listening on :3000")
		expect(coordinator.isRunning).toBe(false)

		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()
		vi.useRealTimers()
		complete({ exitCode: 0 })
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed with exit code 0]")
			} catch {
				return false
			}
		})
		fs.rmSync(logFilePath!, { force: true })
	})

	it("a steering message detaches the command so the agent reads it now", async () => {
		const { process, emitLine, complete } = createControllableTerminalProcess()
		const steer = new AbortController()
		const resultPromise = executeForeground(
			"nsys profile ./bench",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			new AbortController().signal,
			undefined,
			undefined,
			undefined,
			steer.signal,
		)

		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("profiling started")
		steer.abort()
		const result = await resultPromise

		expect(result).toContain("The user sent a new message")
		expect(result).toContain("profiling started")
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()
		complete({ exitCode: 0 })
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed with exit code 0]")
			} catch {
				return false
			}
		})
		fs.rmSync(logFilePath!, { force: true })
	})

	it("detach returns the partial output with the log file path, and later output lands in the log", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, complete } = createControllableTerminalProcess()
		const terminalManager = createFakeTerminalManager(process)

		const resultPromise = executeForeground("devserver", "/workspace", terminalManager, 100_000, undefined, coordinator)

		await waitFor(() => coordinator.isRunning)
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("listening on :3000")

		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise

		expect(result).toContain("still running")
		expect(result).toContain("listening on :3000")
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		// The handle is unregistered once the tool call returns.
		expect(coordinator.isRunning).toBe(false)

		// Output emitted after detach is appended to the log file, and
		// completion closes it out with a completion marker.
		emitLine("compiled successfully")
		complete({ exitCode: 0 })
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed with exit code 0]")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain("listening on :3000") // buffered lines flushed at detach
		expect(log).toContain("compiled successfully") // streamed after detach
		fs.rmSync(logFilePath!, { force: true })
	})

	it("does not label a detached unobserved command as completed in its log", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, completeUnobserved } = createControllableUnobservedTerminalProcess()
		const resultPromise = executeForeground(
			"devserver",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			undefined,
			coordinator,
		)

		await waitFor(() => coordinator.isRunning)
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		completeUnobserved()
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("completion could not be observed")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain("the command may still be running")
		expect(log).not.toContain("[Command completed]")
		fs.rmSync(logFilePath!, { force: true })
	})

	it("does not label a detached terminal closure as completed in its log", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, complete } = createControllableTerminalProcess()
		const resultPromise = executeForeground(
			"devserver",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			undefined,
			coordinator,
		)

		await waitFor(() => coordinator.isRunning)
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		complete({ terminalClosed: true })
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("Terminal closed while the command was running")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain("output may be incomplete")
		expect(log).not.toContain("[Command completed]")
		fs.rmSync(logFilePath!, { force: true })
	})

	it("records a command failure that occurs after detaching and closes the log", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, fail } = createControllableTerminalProcess()
		const resultPromise = executeForeground(
			"devserver",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			undefined,
			coordinator,
		)

		await waitFor(() => coordinator.isRunning)
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		fail(new Error("stream failed"))
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command failed after detaching: stream failed]")
			} catch {
				return false
			}
		})
		expect(fs.readFileSync(logFilePath!, "utf8")).not.toContain("[Command completed]")
		fs.rmSync(logFilePath!, { force: true })
	})

	it("records a detached failure even after command output reaches the log cap", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, fail } = createControllableTerminalProcess()
		const resultPromise = executeForeground(
			"devserver",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			undefined,
			coordinator,
		)

		await waitFor(() => coordinator.isRunning)
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		emitLine("x".repeat(PROCEED_LOG_MAX_BYTES))
		fail(new Error("stream failed after cap"))
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command failed after detaching: stream failed after cap]")
			} catch {
				return false
			}
		})
		fs.rmSync(logFilePath!, { force: true })
	})

	it("detaches each parallel command into its own log file", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const first = createControllableTerminalProcess()
		const second = createControllableTerminalProcess()

		const firstPromise = executeForeground(
			"first-cmd",
			"/workspace",
			createFakeTerminalManager(first.process),
			100_000,
			undefined,
			coordinator,
		)
		const secondPromise = executeForeground(
			"second-cmd",
			"/workspace",
			createFakeTerminalManager(second.process),
			100_000,
			undefined,
			coordinator,
		)

		await waitFor(() => coordinator.isRunning)
		await waitFor(() => first.process.listenerCount("line") > 0 && second.process.listenerCount("line") > 0)
		first.emitLine("first output")
		second.emitLine("second output")

		expect(coordinator.proceedWhileRunning()).toBe(2)
		const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise])

		const firstLog = /redirected to this file[^:]*: (.+)$/m.exec(firstResult)?.[1]?.trim()
		const secondLog = /redirected to this file[^:]*: (.+)$/m.exec(secondResult)?.[1]?.trim()
		expect(firstLog).toBeTruthy()
		expect(secondLog).toBeTruthy()
		expect(firstLog).not.toBe(secondLog)
		expect(coordinator.isRunning).toBe(false)

		first.complete()
		second.complete()
		await waitFor(() => {
			try {
				return (
					fs.readFileSync(firstLog!, "utf8").includes("[Command completed]") &&
					fs.readFileSync(secondLog!, "utf8").includes("[Command completed]")
				)
			} catch {
				return false
			}
		})
		expect(fs.readFileSync(firstLog!, "utf8")).toContain("first output")
		expect(fs.readFileSync(secondLog!, "utf8")).toContain("second output")
		fs.rmSync(firstLog!, { force: true })
		fs.rmSync(secondLog!, { force: true })
	})

	it("registers with the coordinator before terminal acquisition", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, complete } = createControllableTerminalProcess()
		// A terminal acquisition that never settles until released — the
		// registration must not wait for it.
		let releaseTerminal!: () => void
		const terminalGate = new Promise<void>((resolve) => {
			releaseTerminal = resolve
		})
		const terminalManager = {
			getOrCreateTerminal: async () => {
				await terminalGate
				return { terminal: { show: () => {} } } as never
			},
			runCommand: () => process,
		} as unknown as VscodeTerminalManager

		const resultPromise = executeForeground("slow-acquire", "/workspace", terminalManager, 1000, undefined, coordinator)

		await waitFor(() => coordinator.isRunning)
		releaseTerminal()
		await waitFor(() => process.listenerCount("line") > 0)
		complete({ exitCode: 0 })
		await resultPromise
		expect(coordinator.isRunning).toBe(false)
	})

	it("unregisters when terminal acquisition fails", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		let rejectTerminal!: (error: Error) => void
		const terminalGate = new Promise<never>((_, reject) => {
			rejectTerminal = reject
		})
		const terminalManager = {
			getOrCreateTerminal: () => terminalGate,
			runCommand: vi.fn(),
		} as unknown as VscodeTerminalManager

		const resultPromise = executeForeground("failed-acquire", "/workspace", terminalManager, 1000, undefined, coordinator)

		expect(coordinator.isRunning).toBe(true)
		rejectTerminal(new Error("terminal unavailable"))
		await expect(resultPromise).rejects.toThrow("terminal unavailable")
		expect(coordinator.isRunning).toBe(false)
		expect(terminalManager.runCommand).not.toHaveBeenCalled()
	})

	it("aborts during terminal acquisition without starting the command later", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const abortController = new AbortController()
		let releaseTerminal!: () => void
		const terminalGate = new Promise<void>((resolve) => {
			releaseTerminal = resolve
		})
		const runCommand = vi.fn()
		const terminalInfo = { terminal: { show: () => {} }, busy: true }
		const releaseTerminalReservation = vi.fn(() => {
			terminalInfo.busy = false
		})
		const terminalManager = {
			getOrCreateTerminal: async () => {
				await terminalGate
				return terminalInfo as never
			},
			runCommand,
			releaseTerminalReservation,
		} as unknown as VscodeTerminalManager

		const resultPromise = executeForeground(
			"cancelled-before-start",
			"/workspace",
			terminalManager,
			1000,
			abortController.signal,
			coordinator,
		)

		expect(coordinator.isRunning).toBe(true)
		abortController.abort()
		await expect(resultPromise).rejects.toThrow("Command execution aborted")
		expect(coordinator.isRunning).toBe(false)

		releaseTerminal()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(runCommand).not.toHaveBeenCalled()
		expect(releaseTerminalReservation).toHaveBeenCalledWith(terminalInfo)
		expect(terminalInfo.busy).toBe(false)
	})

	it("releases the reservation when acquisition and abort settle in the same promise turn", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const abortController = new AbortController()
		const terminalInfo = { terminal: { show: () => {} }, busy: true }
		const runCommand = vi.fn()
		const releaseTerminalReservation = vi.fn(() => {
			terminalInfo.busy = false
		})
		const terminalManager = {
			getOrCreateTerminal: () =>
				Promise.resolve(terminalInfo as never).then((terminal) => {
					abortController.abort()
					return terminal
				}),
			runCommand,
			releaseTerminalReservation,
		} as unknown as VscodeTerminalManager

		await expect(
			executeForeground("cancelled-as-acquired", "/workspace", terminalManager, 1000, abortController.signal, coordinator),
		).rejects.toThrow("Command execution aborted")

		expect(runCommand).not.toHaveBeenCalled()
		expect(releaseTerminalReservation).toHaveBeenCalledWith(terminalInfo)
		expect(terminalInfo.busy).toBe(false)
		expect(coordinator.isRunning).toBe(false)
	})

	it("detach requested during terminal acquisition applies once the command starts", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, completeUnobserved } = createControllableUnobservedTerminalProcess()
		let releaseTerminal!: () => void
		const terminalGate = new Promise<void>((resolve) => {
			releaseTerminal = resolve
		})
		const terminalManager = {
			getOrCreateTerminal: async () => {
				await terminalGate
				return { terminal: { show: () => {} } } as never
			},
			runCommand: () => process,
		} as unknown as VscodeTerminalManager

		const resultPromise = executeForeground("late-cmd", "/workspace", terminalManager, 100_000, undefined, coordinator)
		await waitFor(() => coordinator.isRunning)

		// Proceed While Running fires while this command is still waiting for
		// its terminal. The detach must stick: once the command starts, it
		// resolves as detached instead of re-blocking the turn.
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		expect(result).toContain("still running")
		expect(coordinator.isRunning).toBe(false)

		// The tool result settles before terminal acquisition. Once the bounded
		// acquisition finishes, the approved command starts and streams to the log.
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()
		releaseTerminal()
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("started late")
		completeUnobserved()
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("completion could not be observed")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain("started late")
		expect(log).toContain("the command may still be running")
		expect(log).not.toContain("[Command completed]")
		fs.rmSync(logFilePath!, { force: true })
	})

	it("records terminal acquisition failure after detach in the promised log", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		let rejectTerminal!: (error: Error) => void
		const terminalGate = new Promise<never>((_, reject) => {
			rejectTerminal = reject
		})
		const terminalManager = {
			getOrCreateTerminal: () => terminalGate,
			runCommand: vi.fn(),
		} as unknown as VscodeTerminalManager

		const resultPromise = executeForeground(
			"failed-after-detach",
			"/workspace",
			terminalManager,
			1000,
			undefined,
			coordinator,
		)
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()
		expect(coordinator.isRunning).toBe(false)

		rejectTerminal(new Error("terminal unavailable"))
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("terminal unavailable")
			} catch {
				return false
			}
		})
		expect(terminalManager.runCommand).not.toHaveBeenCalled()
		fs.rmSync(logFilePath!, { force: true })
	})

	it("records a detached process failure after the tool result settles", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, fail } = createControllableTerminalProcess()
		const resultPromise = executeForeground(
			"failed-process",
			"/workspace",
			createFakeTerminalManager(process),
			1000,
			undefined,
			coordinator,
		)

		await waitFor(() => process.listenerCount("line") > 0)
		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		fail(new Error("terminal process failed"))
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("terminal process failed")
			} catch {
				return false
			}
		})
		expect(process.listenerCount("line")).toBe(0)
		fs.rmSync(logFilePath!, { force: true })
	})

	it("detaches a whole parallel batch even when one command is still awaiting its terminal", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const first = createControllableTerminalProcess()
		const second = createControllableTerminalProcess()
		let releaseSecondTerminal!: () => void
		const secondTerminalGate = new Promise<void>((resolve) => {
			releaseSecondTerminal = resolve
		})
		const secondTerminalManager = {
			getOrCreateTerminal: async () => {
				await secondTerminalGate
				return { terminal: { show: () => {} } } as never
			},
			runCommand: () => second.process,
		} as unknown as VscodeTerminalManager

		const firstPromise = executeForeground(
			"first-cmd",
			"/workspace",
			createFakeTerminalManager(first.process),
			100_000,
			undefined,
			coordinator,
		)
		const secondPromise = executeForeground(
			"second-cmd",
			"/workspace",
			secondTerminalManager,
			100_000,
			undefined,
			coordinator,
		)
		await waitFor(() => coordinator.isRunning)

		// The user clicks Proceed While Running while the second command is
		// still waiting for a terminal; both must be counted and both must
		// resolve detached — the late one must not keep the turn blocked.
		expect(coordinator.proceedWhileRunning()).toBe(2)
		const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise])
		expect(firstResult).toContain("still running")
		expect(secondResult).toContain("still running")
		expect(coordinator.isRunning).toBe(false)

		const logFilePaths = [firstResult, secondResult].map((result) =>
			/redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim(),
		)
		for (const logFilePath of logFilePaths) {
			expect(logFilePath).toBeTruthy()
		}
		releaseSecondTerminal()
		await waitFor(() => first.process.listenerCount("line") > 0 && second.process.listenerCount("line") > 0)
		first.complete()
		second.complete()
		await waitFor(() =>
			logFilePaths.every((logFilePath) => {
				try {
					return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed]")
				} catch {
					return false
				}
			}),
		)
		for (const logFilePath of logFilePaths) {
			fs.rmSync(logFilePath!, { force: true })
		}
	})

	it("stops logging before a line that would exceed the size cap", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, complete } = createControllableTerminalProcess()
		const terminalManager = createFakeTerminalManager(process)

		const resultPromise = executeForeground("devserver", "/workspace", terminalManager, 100_000, undefined, coordinator)
		await waitFor(() => coordinator.isRunning)
		await waitFor(() => process.listenerCount("line") > 0)

		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()

		// A single line larger than the whole cap must not be written at all —
		// the cap is checked before writing, so one huge line (e.g. a dumped
		// blob) cannot blow the log far past PROCEED_LOG_MAX_BYTES.
		emitLine("small line before the blob")
		emitLine("x".repeat(PROCEED_LOG_MAX_BYTES))
		emitLine("after the cap")
		complete({ exitCode: 0 })

		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed with exit code 0]")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain("small line before the blob")
		expect(log).toContain(`[Log size cap of ${PROCEED_LOG_MAX_BYTES} bytes reached`)
		expect(log).not.toContain("xxxx")
		expect(log).not.toContain("after the cap")
		expect(log.length).toBeLessThan(PROCEED_LOG_MAX_BYTES)
		fs.rmSync(logFilePath!, { force: true })
	})

	it("applies the size cap to lines buffered before detach", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, complete } = createControllableTerminalProcess()
		const terminalManager = createFakeTerminalManager(process)

		const resultPromise = executeForeground("devserver", "/workspace", terminalManager, 100_000, undefined, coordinator)
		await waitFor(() => coordinator.isRunning)
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("x".repeat(PROCEED_LOG_MAX_BYTES))

		expect(coordinator.proceedWhileRunning()).toBe(1)
		const result = await resultPromise
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(logFilePath).toBeTruthy()
		complete({ exitCode: 0 })

		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed with exit code 0]")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain(`[Log size cap of ${PROCEED_LOG_MAX_BYTES} bytes reached`)
		expect(log).not.toContain("xxxx")
		expect(Buffer.byteLength(log)).toBeLessThanOrEqual(PROCEED_LOG_MAX_BYTES)
		fs.rmSync(logFilePath!, { force: true })
	})

	it("freezes the partial output at detach while later output still reaches the log", async () => {
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, complete } = createControllableTerminalProcess()
		const terminalManager = createFakeTerminalManager(process)

		const resultPromise = executeForeground("devserver", "/workspace", terminalManager, 100_000, undefined, coordinator)
		await waitFor(() => coordinator.isRunning)
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("before detach")

		expect(coordinator.proceedWhileRunning()).toBe(1)
		// Emitted after detach but before the tool call's result is built:
		// must appear only in the log, never in the partial output.
		emitLine("after detach")
		const result = await resultPromise

		expect(result).toContain("before detach")
		expect(result).not.toContain("after detach")

		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		complete({ exitCode: 0 })
		await waitFor(() => {
			try {
				return fs.readFileSync(logFilePath!, "utf8").includes("[Command completed with exit code 0]")
			} catch {
				return false
			}
		})
		const log = fs.readFileSync(logFilePath!, "utf8")
		expect(log).toContain("before detach")
		expect(log).toContain("after detach")
		fs.rmSync(logFilePath!, { force: true })
	})
})

describe("background processes", () => {
	const toolContext: AgentToolContext = { agentId: "agent-1", sessionId: "session-1", iteration: 1 }

	/** A terminal manager whose terminal can be interrupted and closed. */
	function createKillableTerminalManager(
		process: ReturnType<VscodeTerminalManager["runCommand"]>,
		terminalInfo: { busy: boolean },
	) {
		const sendInterrupt = vi.fn()
		const disposeTerminal = vi.fn()
		const manager = {
			getOrCreateTerminal: async () => terminalInfo,
			runCommand: () => process,
			sendInterrupt,
			disposeTerminal,
		} as unknown as VscodeTerminalManager
		return { manager, sendInterrupt, disposeTerminal }
	}

	/**
	 * A spawning executor that runs until aborted or finished by the test,
	 * streaming output the way the engine's does (emitUpdate chunks).
	 */
	function createFakeShellExecutor() {
		const calls: Array<{ context: AgentToolContext; finish: (exitCode: number) => void }> = []
		const executor: ShellExecutor = (_command, _cwd, context) =>
			new Promise<string>((resolve, reject) => {
				context.signal?.addEventListener("abort", () => reject(new Error("Command was aborted")), { once: true })
				calls.push({
					context,
					finish: (exitCode) => (exitCode === 0 ? resolve("") : reject(new CommandExitError(exitCode, ""))),
				})
			})
		return { executor, calls }
	}

	async function readLogWhen(logPath: string, text: string): Promise<string> {
		await waitFor(() => {
			try {
				return fs.readFileSync(logPath, "utf8").includes(text)
			} catch {
				return false
			}
		})
		return fs.readFileSync(logPath, "utf8")
	}

	it("registers a handed-over terminal command with its log file", async () => {
		const registry = new ProcessRegistry()
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, emitLine, complete } = createControllableTerminalProcess()

		const resultPromise = executeForeground(
			"npm run dev",
			"/workspace",
			createFakeTerminalManager(process),
			100_000,
			undefined,
			coordinator,
			undefined,
			"session-1",
			undefined,
			{ registry, conversationId: "session-1" },
		)
		await waitFor(() => process.listenerCount("line") > 0)
		emitLine("listening on :3000")
		coordinator.proceedWhileRunning()
		const result = await resultPromise

		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		expect(result).toContain("It is tracked as process p1: process_output reads its log and process_kill stops it.")
		expect(registry.list("session-1")).toEqual([
			expect.objectContaining({
				id: "p1",
				command: "npm run dev",
				cwd: "/workspace",
				source: "terminal",
				status: "running",
				logPath: logFilePath,
			}),
		])

		complete({ exitCode: 0 })
		await readLogWhen(logFilePath!, "[Command completed with exit code 0]")
		expect(registry.get("p1")).toMatchObject({ status: "exited", exitCode: 0 })
		fs.rmSync(logFilePath!, { force: true })
	})

	it("registers a command handed over before it had a terminal, and kills it once it starts", async () => {
		vi.useFakeTimers()
		const registry = new ProcessRegistry()
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process, complete } = createControllableTerminalProcess()
		let provideTerminal!: (info: { busy: boolean }) => void
		const terminalInfo = { busy: true }
		const sendInterrupt = vi.fn(() => complete({ exitCode: 130 }))
		const manager = {
			getOrCreateTerminal: () =>
				new Promise((resolve) => {
					provideTerminal = resolve
				}),
			runCommand: () => process,
			sendInterrupt,
			disposeTerminal: vi.fn(),
		} as unknown as VscodeTerminalManager

		const resultPromise = executeForeground(
			"npm run dev",
			"/workspace",
			manager,
			100_000,
			undefined,
			coordinator,
			undefined,
			"session-1",
			undefined,
			{ registry, conversationId: "session-1" },
		)
		coordinator.proceedWhileRunning()
		const result = await resultPromise
		expect(result).toContain("tracked as process p1")

		const killing = registry.kill("p1")
		expect(sendInterrupt).not.toHaveBeenCalled()
		provideTerminal(terminalInfo)
		await vi.advanceTimersByTimeAsync(2000)
		await killing

		expect(sendInterrupt).toHaveBeenCalledOnce()
		expect(registry.get("p1")).toMatchObject({ status: "killed", exitCode: 130 })
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		vi.useRealTimers()
		fs.rmSync(logFilePath!, { force: true })
	})

	it("kills a handed-over command with Ctrl+C, and closes its terminal when that does not stop it", async () => {
		vi.useFakeTimers()
		const registry = new ProcessRegistry()
		const coordinator = new SdkForegroundCommandCoordinator()
		const { process } = createControllableTerminalProcess()
		const terminalInfo = { busy: true }
		const { manager, sendInterrupt, disposeTerminal } = createKillableTerminalManager(process, terminalInfo)

		const resultPromise = executeForeground(
			"tail -f server.log",
			"/workspace",
			manager,
			100_000,
			undefined,
			coordinator,
			undefined,
			"session-1",
			undefined,
			{ registry, conversationId: "session-1" },
		)
		await vi.waitFor(() => expect(process.listenerCount("line")).toBeGreaterThan(0))
		coordinator.proceedWhileRunning()
		const result = await resultPromise

		const killing = registry.kill("p1")
		expect(sendInterrupt).toHaveBeenCalledWith(terminalInfo)
		expect(disposeTerminal).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(2000)
		await killing

		expect(disposeTerminal).toHaveBeenCalledWith(terminalInfo)
		expect(registry.get("p1")?.status).toBe("killed")
		const logFilePath = /redirected to this file[^:]*: (.+)$/m.exec(result)?.[1]?.trim()
		vi.useRealTimers()
		fs.rmSync(logFilePath!, { force: true })
	})

	it("does not register a command that completes while the call waits", async () => {
		const registry = new ProcessRegistry()
		const process = createFakeTerminalProcess({ lines: ["ok"], completionDetails: { exitCode: 0 } })
		const tool = createVscodeRunCommandsTool({
			cwd: "/workspace",
			getTerminalManager: () => createFakeTerminalManager(process),
			processes: registry,
		})

		await tool.execute({ commands: ["echo ok"] }, toolContext)

		expect(registry.list()).toEqual([])
	})

	it("starts `background: true` commands as processes and returns at once", async () => {
		const registry = new ProcessRegistry()
		const fake = createFakeShellExecutor()
		mocks.fakeShellExecutor = fake.executor
		const getTerminalManager = vi.fn(() => createFakeTerminalManager(createFakeTerminalProcess({})))
		const tool = createVscodeRunCommandsTool({ cwd: "/workspace", getTerminalManager, processes: registry })

		const results = (await tool.execute(
			{ commands: ["npm run dev", "bun test --watch"], background: true },
			toolContext,
		)) as Array<{ result: string; success: boolean }>

		expect(getTerminalManager).not.toHaveBeenCalled()
		expect(results).toHaveLength(2)
		expect(results[0].success).toBe(true)
		expect(results[0].result).toMatch(
			/^Started npm run dev as process p1 \(log: .+\)\. Use process_output to read it and process_kill to stop it\.$/,
		)
		expect(results[1].result).toContain("as process p2")
		expect(registry.list("session-1").map((process) => [process.id, process.source, process.status])).toEqual([
			["p1", "child", "running"],
			["p2", "child", "running"],
		])

		// Output streams into the log while the command runs.
		const [first, second] = fake.calls
		first.context.emitUpdate?.({ stream: "stdout", chunk: "compiled in 2s\n" })
		const logPath = registry.get("p1")!.logPath
		expect(await readLogWhen(logPath, "compiled in 2s")).toContain("[Running command: npm run dev]")

		// process_kill aborts it.
		await registry.kill("p1")
		expect(first.context.signal?.aborted).toBe(true)
		expect(registry.get("p1")?.status).toBe("killed")
		await readLogWhen(logPath, "[Command stopped]")

		// One that ends by itself keeps its exit code.
		second.finish(2)
		await waitFor(() => registry.get("p2")?.status === "exited")
		expect(registry.get("p2")?.exitCode).toBe(2)
		await readLogWhen(registry.get("p2")!.logPath, "[Command exited with code 2]")

		fs.rmSync(logPath, { force: true })
		fs.rmSync(registry.get("p2")!.logPath, { force: true })
	})

	it("offers `background` only with a registry, and leaves calls without it unchanged", async () => {
		const options = {
			cwd: "/workspace",
			getTerminalManager: () => createFakeTerminalManager(createFakeTerminalProcess({ lines: ["plain"] })),
		}
		const plain = createVscodeRunCommandsTool(options)
		expect(JSON.stringify(plain.inputSchema)).not.toContain("background")
		expect(plain.description).not.toContain("background: true")

		const registry = new ProcessRegistry()
		const withProcesses = createVscodeRunCommandsTool({ ...options, processes: registry })
		expect((withProcesses.inputSchema as { properties: Record<string, unknown> }).properties.background).toEqual(
			expect.objectContaining({ type: "boolean" }),
		)
		expect(withProcesses.description).toContain("`background: true`")
		expect(withProcesses.description).toContain("still running after 5 minutes")

		const results = await withProcesses.execute({ commands: ["echo plain"], background: false }, toolContext)
		expect(results).toEqual([expect.objectContaining({ result: "plain", success: true })])
		expect(registry.list()).toEqual([])
	})
})
