import * as vscode from "vscode"
import { buildEffectiveProviderConfig } from "@/sdk/model-catalog/effective-config"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { requestPlinyBudget } from "@/sdk/pliny-budget"
import { Logger } from "@/shared/services/Logger"
import type { PlinyApiKeys } from "./pliny-api-keys"

const TITLE = "Pliny API key"

/**
 * Asks for a name and then the key, checks the key against the gateway and
 * stores it. The key is typed into VS Code's own password box, so it never
 * passes through the webview. Returns false when the user cancelled.
 */
export async function promptAddPlinyApiKey(keys: PlinyApiKeys): Promise<boolean> {
	const taken = new Set(keys.list().map((k) => k.name.toLowerCase()))
	const name = await askForName(keys.list().length === 0 ? "Default" : "", taken)
	if (!name) {
		return false
	}
	let problem: string | undefined
	for (;;) {
		const key = await askForKey(name, problem)
		if (!key) {
			return false
		}
		const duplicate = await keys.findByValue(key)
		problem = duplicate ? `This key is already stored as "${duplicate.name}".` : await checkPlinyApiKey(key)
		if (!problem) {
			await keys.add(name, key)
			Logger.log(`[PlinyApiKeys] Stored a Pliny API key named "${name}"`)
			return true
		}
	}
}

export async function promptRenamePlinyApiKey(keys: PlinyApiKeys, id: string): Promise<boolean> {
	const entry = keys.list().find((k) => k.id === id)
	if (!entry) {
		return false
	}
	const taken = new Set(keys.list().flatMap((k) => (k.id === id ? [] : [k.name.toLowerCase()])))
	const name = await askForName(entry.name, taken)
	if (!name || name === entry.name) {
		return false
	}
	await keys.rename(id, name)
	return true
}

function askForName(value: string, taken: ReadonlySet<string>): Thenable<string | undefined> {
	return vscode.window
		.showInputBox({
			title: TITLE,
			prompt: "A name or tag to recognise this key by (e.g. Personal, Team budget)",
			value,
			ignoreFocusOut: true,
			validateInput: (input) => {
				const trimmed = input.trim()
				if (!trimmed) {
					return "Enter a name"
				}
				return taken.has(trimmed.toLowerCase()) ? "Another key already has this name" : undefined
			},
		})
		.then((input) => input?.trim() || undefined)
}

function askForKey(name: string, problem?: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const box = vscode.window.createInputBox()
		box.title = `${TITLE}: ${name}`
		box.placeholder = "Pliny API key"
		box.prompt = "Paste the key. It is checked against the Pliny gateway and kept in the OS keychain."
		box.password = true
		box.ignoreFocusOut = true
		box.validationMessage = problem
		let settled = false
		const done = (value: string | undefined) => {
			if (settled) return
			settled = true
			resolve(value)
			box.dispose()
		}
		box.onDidChangeValue(() => {
			box.validationMessage = undefined
		})
		box.onDidAccept(() => {
			const value = box.value.trim()
			if (value) done(value)
		})
		box.onDidHide(() => done(undefined))
		box.show()
	})
}

/**
 * Why the gateway rejected `key`, or undefined when it accepted it or could
 * not be asked (the network, a proxy): a key that cannot be checked now is kept.
 */
async function checkPlinyApiKey(key: string): Promise<string | undefined> {
	try {
		const { status } = await requestPlinyBudget(key, buildEffectiveProviderConfig(parseProviderId("pliny")))
		if (status === 401 || status === 403) {
			return `The Pliny gateway rejected this key (HTTP ${status}). Check it and try again.`
		}
		return undefined
	} catch (error) {
		Logger.warn(
			`[PlinyApiKeys] Could not check the key against the gateway: ${error instanceof Error ? error.message : error}`,
		)
		return undefined
	}
}
