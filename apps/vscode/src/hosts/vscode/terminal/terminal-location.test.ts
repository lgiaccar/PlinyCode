import { beforeEach, describe, expect, it, vi } from "vitest"

const settings = vi.hoisted(() => ({
	values: {} as Record<string, unknown>,
	update: vi.fn(async (_key: string, _value: unknown, _target: unknown) => {}),
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section: string) => {
			expect(section).toBe("plinycode.terminal")
			return { get: (key: string) => settings.values[key], update: settings.update }
		},
	},
	ViewColumn: { Active: -1 },
	ConfigurationTarget: { Global: 1 },
}))

import {
	isNarrowTerminalWarningEnabled,
	readTerminalLocation,
	setTerminalLocation,
	terminalLocationOption,
} from "./terminal-location"

describe("terminal location", () => {
	beforeEach(() => {
		settings.values = {}
		settings.update.mockClear()
	})

	it("reads the panel unless the setting says editor", () => {
		expect(readTerminalLocation()).toBe("panel")
		settings.values.location = "sideways"
		expect(readTerminalLocation()).toBe("panel")
		settings.values.location = "editor"
		expect(readTerminalLocation()).toBe("editor")
	})

	it("opens an editor terminal in the active group without taking focus, and a panel one as before", () => {
		expect(terminalLocationOption("editor")).toEqual({ viewColumn: -1, preserveFocus: true })
		expect(terminalLocationOption("panel")).toBeUndefined()
	})

	it("stores the choice for every workspace, and warns unless turned off", async () => {
		await setTerminalLocation("editor")
		expect(settings.update).toHaveBeenCalledWith("location", "editor", 1)
		expect(isNarrowTerminalWarningEnabled()).toBe(true)
		settings.values.narrowWarning = false
		expect(isNarrowTerminalWarningEnabled()).toBe(false)
	})
})
