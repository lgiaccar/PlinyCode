import { type InstructionEditor, setInstructionHost } from "@plinycode/shared/storage"
import type { ClineRulesToggles } from "@shared/cline-rules"
import { Logger } from "@shared/services/Logger"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Where rules and skills come from, decided once at activation.
 *
 * The engine reads rule and skill files itself. Left alone it loads every
 * editor's agent files (`.github`, `.cursor`, `.windsurfrules`) and guesses
 * four global rules folders. PlinyCode knows which editor it runs in and which
 * global folder the Rules panel uses, so it tells the engine, and the model
 * gets one editor's files and one global folder.
 */

let hostIdeName = "VS Code"

/** The editor name the system prompt reports, e.g. "Cursor" or "VS Code". */
export function getHostIdeName(): string {
	return hostIdeName
}

export function detectInstructionEditor(appName: string): InstructionEditor {
	const name = appName.toLowerCase()
	if (name.includes("cursor")) {
		return "cursor"
	}
	if (name.includes("windsurf")) {
		return "windsurf"
	}
	return "vscode"
}

function ideDisplayName(editor: InstructionEditor, appName: string): string {
	switch (editor) {
		case "cursor":
			return "Cursor"
		case "windsurf":
			return "Windsurf"
		default:
			return appName.trim() || "VS Code"
	}
}

interface ConfigureInstructionSourcesOptions {
	/** `vscode.env.appName`. */
	appName: string
	/** The global rules folder the Rules panel creates files in. */
	globalRulesDirectory: string
	/** Where rules lived before; defaults to `~/.cline/rules`. */
	deprecatedGlobalRulesDirectory?: string
	getGlobalToggles: () => ClineRulesToggles
	setGlobalToggles: (toggles: ClineRulesToggles) => void
}

export async function configureInstructionSources(options: ConfigureInstructionSourcesOptions): Promise<void> {
	const editor = detectInstructionEditor(options.appName)
	hostIdeName = ideDisplayName(editor, options.appName)
	setInstructionHost({ editor, globalRulesDirectory: options.globalRulesDirectory })
	Logger.log(`[instructions] editor=${editor} globalRules=${options.globalRulesDirectory}`)

	await migrateDeprecatedGlobalRules({
		from: options.deprecatedGlobalRulesDirectory ?? path.join(os.homedir(), ".cline", "rules"),
		to: options.globalRulesDirectory,
		getGlobalToggles: options.getGlobalToggles,
		setGlobalToggles: options.setGlobalToggles,
	})
}

/**
 * `~/.cline/rules` is no longer read. Its files move to the global rules
 * folder, keeping their Rules panel toggle; a file whose name is already taken
 * there stays put and is reported in the log.
 */
export async function migrateDeprecatedGlobalRules(options: {
	from: string
	to: string
	getGlobalToggles: () => ClineRulesToggles
	setGlobalToggles: (toggles: ClineRulesToggles) => void
}): Promise<{ moved: string[]; skipped: string[] }> {
	const result = { moved: [] as string[], skipped: [] as string[] }
	if (path.resolve(options.from) === path.resolve(options.to)) {
		return result
	}
	let entries: import("fs").Dirent[]
	try {
		entries = await fs.readdir(options.from, { withFileTypes: true })
	} catch {
		return result
	}
	const files = entries.filter((entry) => entry.isFile())
	if (files.length === 0) {
		return result
	}

	await fs.mkdir(options.to, { recursive: true })
	const toggles = { ...options.getGlobalToggles() }
	let togglesChanged = false
	for (const file of files) {
		const source = path.join(options.from, file.name)
		const target = path.join(options.to, file.name)
		try {
			await fs.access(target)
			result.skipped.push(source)
			continue
		} catch {
			// Target is free.
		}
		try {
			await fs.rename(source, target)
		} catch {
			// Different volume: copy, then remove the original.
			await fs.copyFile(source, target)
			await fs.rm(source)
		}
		result.moved.push(target)
		if (source in toggles) {
			toggles[target] = toggles[source]
			delete toggles[source]
			togglesChanged = true
		}
	}
	if (togglesChanged) {
		options.setGlobalToggles(toggles)
	}
	if (result.moved.length > 0) {
		Logger.log(`[instructions] Moved ${result.moved.length} rule file(s) from ${options.from} to ${options.to}`)
	}
	if (result.skipped.length > 0) {
		Logger.warn(
			`[instructions] ${options.from} is no longer read. These files were not moved because ${options.to} already has a file with the same name: ${result.skipped.join(", ")}`,
		)
	}
	return result
}
