import { beforeEach, describe, expect, it, vi } from "vitest"

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown>, shell: "powershell.exe" }))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section: string) => {
			expect(section).toBe("plinycode.terminal")
			return { get: (key: string) => settings.values[key] }
		},
	},
}))

vi.mock("@/utils/shell", () => ({ getShell: () => settings.shell }))

import type * as vscode from "vscode"
import {
	canUseWideOutput,
	isWideOutputEnabled,
	prepareWideOutput,
	WIDE_OUTPUT_ENV_VAR,
	WIDE_OUTPUT_FUNCTION,
	WIDE_OUTPUT_PREPARE_COMMAND,
	wideOutputCommand,
	wideOutputEnv,
} from "./wide-output"

function fakeTerminal(options: { env?: Record<string, string>; shellPath?: string; detectedShell?: string; output?: string[] }): {
	terminal: vscode.Terminal
	executeCommand: ReturnType<typeof vi.fn>
} {
	const executeCommand = vi.fn(() => ({
		read: async function* () {
			yield* options.output ?? []
		},
	}))
	const terminal = {
		creationOptions: { env: options.env, shellPath: options.shellPath },
		state: { shell: options.detectedShell },
		shellIntegration: { executeCommand },
	} as unknown as vscode.Terminal
	return { terminal, executeCommand }
}

const WITH_WRAPPER = { [WIDE_OUTPUT_ENV_VAR]: "source" }

describe("wide output", () => {
	beforeEach(() => {
		settings.values = {}
		settings.shell = "powershell.exe"
	})

	it("is on unless turned off", () => {
		expect(isWideOutputEnabled()).toBe(true)
		settings.values.wideOutput = false
		expect(isWideOutputEnabled()).toBe(false)
	})

	it("puts the wrapper in the environment of PowerShell terminals only", () => {
		expect(wideOutputEnv("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual({
			[WIDE_OUTPUT_ENV_VAR]: WIDE_OUTPUT_FUNCTION,
		})
		expect(wideOutputEnv("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toHaveProperty(
			WIDE_OUTPUT_ENV_VAR,
		)
		expect(wideOutputEnv("/usr/bin/pwsh")).toHaveProperty(WIDE_OUTPUT_ENV_VAR)
		expect(wideOutputEnv("C:\\Program Files\\Git\\bin\\bash.exe")).toEqual({})
		expect(wideOutputEnv("C:\\WINDOWS\\System32\\cmd.exe")).toEqual({})
		// The default profile: the shell VS Code would launch.
		expect(wideOutputEnv(undefined)).toHaveProperty(WIDE_OUTPUT_ENV_VAR)
		settings.shell = "/bin/zsh"
		expect(wideOutputEnv(undefined)).toEqual({})
	})

	it("is used only in terminals created with the wrapper that run PowerShell", () => {
		expect(canUseWideOutput(fakeTerminal({ shellPath: "pwsh.exe" }).terminal)).toBe(false)
		expect(canUseWideOutput(fakeTerminal({ env: WITH_WRAPPER, shellPath: "pwsh.exe" }).terminal)).toBe(true)
		// The detected shell follows a sub-shell and wins over the path.
		expect(canUseWideOutput(fakeTerminal({ env: WITH_WRAPPER, shellPath: "pwsh.exe", detectedShell: "bash" }).terminal)).toBe(
			false,
		)
		expect(canUseWideOutput(fakeTerminal({ env: WITH_WRAPPER, shellPath: "bash", detectedShell: "pwsh" }).terminal)).toBe(
			true,
		)
	})

	it("quotes the command as a PowerShell string, typographic quotes included", () => {
		expect(wideOutputCommand("npm test")).toBe(". plinyrun 'npm test'")
		expect(wideOutputCommand("git commit -m 'it''s' # done")).toBe(". plinyrun 'git commit -m ''it''''s'' # done'")
		expect(wideOutputCommand("echo \u2018a\u2019")).toBe(". plinyrun 'echo \u2018\u2018a\u2019\u2019'")
	})

	it("keeps the wrapper free of characters a template literal would change", () => {
		expect(WIDE_OUTPUT_FUNCTION).not.toContain("`")
		expect(WIDE_OUTPUT_FUNCTION).not.toContain("${")
		expect(WIDE_OUTPUT_FUNCTION).toContain("Out-String -Stream -Width 400")
	})

	it("is ready once the terminal prints the marker, and prepares each terminal once", async () => {
		const { terminal, executeCommand } = fakeTerminal({
			env: WITH_WRAPPER,
			output: [`\x1b]633;E;${WIDE_OUTPUT_PREPARE_COMMAND}\x07`, "\x1b]633;C\x07plinycode-wide-output-ready\r\n"],
		})
		expect(await prepareWideOutput(terminal)).toBe(true)
		expect(await prepareWideOutput(terminal)).toBe(true)
		expect(executeCommand).toHaveBeenCalledTimes(1)
		expect(executeCommand).toHaveBeenCalledWith(WIDE_OUTPUT_PREPARE_COMMAND)
	})

	it("is not ready when only the echoed command came back, even wrapped by ConPTY", async () => {
		// Constrained Language mode: the marker is never printed. The echo,
		// split at 40 columns, must not pass for it.
		const echo = WIDE_OUTPUT_PREPARE_COMMAND.match(/.{1,40}/g) ?? []
		const { terminal } = fakeTerminal({ env: WITH_WRAPPER, output: [echo.join("\r\n"), "\r\n"] })
		expect(await prepareWideOutput(terminal)).toBe(false)
	})

	it("is not ready without shell integration", async () => {
		const terminal = { creationOptions: { env: WITH_WRAPPER } } as unknown as vscode.Terminal
		expect(await prepareWideOutput(terminal)).toBe(false)
	})
})
