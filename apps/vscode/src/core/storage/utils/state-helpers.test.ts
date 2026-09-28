import { afterEach, describe, expect, it, mock } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"

mock.module("../StateManager", () => ({ StateManager: {} }))

describe("readGlobalStateFromStorage terminal execution mode", () => {
	const temporaryDirectories: string[] = []

	afterEach(() => {
		for (const temporaryDirectory of temporaryDirectories.splice(0)) {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true })
		}
	})

	async function readTerminalExecutionMode(storedValue?: "vscodeTerminal" | "backgroundExec") {
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cline-terminal-mode-"))
		temporaryDirectories.push(temporaryDirectory)
		const storage = new ClineFileStorage(path.join(temporaryDirectory, "globalState.json"))
		if (storedValue !== undefined) {
			await storage.update("vscodeTerminalExecutionMode", storedValue)
		}

		const { readGlobalStateFromStorage } = await import("./state-helpers")
		const state = await readGlobalStateFromStorage(storage)
		return state.vscodeTerminalExecutionMode
	}

	it("uses the VS Code terminal when no preference is stored", async () => {
		expect(await readTerminalExecutionMode()).toBe("vscodeTerminal")
	})

	it.each(["vscodeTerminal", "backgroundExec"] as const)("preserves a stored %s preference", async (storedValue) => {
		expect(await readTerminalExecutionMode(storedValue)).toBe(storedValue)
	})
})

describe("purgeRemovedSecrets", () => {
	const temporaryDirectories: string[] = []

	afterEach(() => {
		for (const temporaryDirectory of temporaryDirectories.splice(0)) {
			fs.rmSync(temporaryDirectory, { force: true, recursive: true })
		}
	})

	function createSecretsStorage(): { storage: ClineFileStorage<string>; filePath: string } {
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "plinycode-secrets-purge-"))
		temporaryDirectories.push(temporaryDirectory)
		const filePath = path.join(temporaryDirectory, "secrets.json")
		return { storage: new ClineFileStorage<string>(filePath), filePath }
	}

	it("deletes the secrets of removed features and keeps the others", async () => {
		const { storage, filePath } = createSecretsStorage()
		await storage.setBatch({ ocaApiKey: "oca-token", ocaRefreshToken: "oca-refresh", plinyApiKey: "pliny-key" })

		const { purgeRemovedSecrets } = await import("./state-helpers")
		purgeRemovedSecrets(storage)

		expect(storage.get("ocaApiKey")).toBeUndefined()
		expect(storage.get("ocaRefreshToken")).toBeUndefined()
		expect(storage.get<string>("plinyApiKey")).toBe("pliny-key")
		expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual({ plinyApiKey: "pliny-key" })
	})

	it("does not write the store when nothing needs purging", async () => {
		const { storage, filePath } = createSecretsStorage()

		const { purgeRemovedSecrets } = await import("./state-helpers")
		purgeRemovedSecrets(storage)

		expect(fs.existsSync(filePath)).toBe(false)
	})
})
