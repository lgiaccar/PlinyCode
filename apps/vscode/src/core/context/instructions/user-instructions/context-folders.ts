import { Controller } from "@core/controller"
import { ClineRulesToggles } from "@shared/cline-rules"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import path from "path"

/**
 * Refresh auto-generated context-folder rules.
 *
 * Scans configured context folders (e.g. `.github`, `.vscode`) and creates combined
 * rule files inside `.cline/rules/`. New files are added to the local Cline
 * rules toggles but left **disabled** so the user must opt in.
 *
 * This function respects user configuration:
 * - plinycode.contextFolders.enabled (boolean, default: true)
 * - plinycode.contextFolders.folders (string[], default: [".github", ".vscode", ".devcontainer", ".cursor"])
 */
export async function refreshContextFolderRules(controller: Controller, workingDirectory: string): Promise<void> {
	// Check if context folder scanning is enabled
	const isEnabled = controller.stateManager.getGlobalSettingsKey("plinycodeContextFoldersEnabled")
	if (!isEnabled) {
		return
	}

	// Get configured context folders
	const configuredFolders = controller.stateManager.getGlobalSettingsKey("plinycodeContextFolders")
	const CONTEXT_FOLDERS =
		configuredFolders && configuredFolders.length > 0 ? configuredFolders : [".github", ".vscode", ".devcontainer", ".cursor"]

	/** File extensions to include from context folders */
	const CONTEXT_EXTENSIONS = new Set([".md", ".txt", ".mdc", ".json"])

	/** Prefix for auto-generated context rule files */
	const GENERATED_PREFIX = "pliny-context-"

	/** Folders to exclude from scanning */
	const EXCLUDED_FOLDERS = new Set(["rules"]) // Don't scan .cursor/rules as it's handled separately

	/**
	 * Check if a file path has a supported extension for context inclusion
	 */
	function hasContextExtension(filePath: string): boolean {
		const ext = path.extname(filePath).toLowerCase()
		return CONTEXT_EXTENSIONS.has(ext)
	}

	/**
	 * Recursively find readable context files up to a max depth.
	 * Skips excluded directories.
	 */
	async function* walkContextFiles(
		dir: string,
		maxDepth: number,
		baseDir: string = dir,
	): AsyncGenerator<{ relativePath: string; fullPath: string }> {
		if (maxDepth < 0) return
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true })
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name)

				// Skip excluded directories
				if (entry.isDirectory() && EXCLUDED_FOLDERS.has(entry.name)) {
					continue
				}

				// Special handling for .cursor/rules exclusion
				if (entry.name === "rules" && path.basename(dir) === ".cursor") {
					continue
				}

				if (entry.isDirectory() && maxDepth > 0) {
					yield* walkContextFiles(fullPath, maxDepth - 1, baseDir)
				} else if (entry.isFile() && hasContextExtension(fullPath)) {
					yield { relativePath: path.relative(baseDir, fullPath), fullPath }
				}
			}
		} catch {
			// Ignore permission errors etc.
		}
	}

	/**
	 * Calculate total size of context files in a folder
	 */
	async function calculateFolderSize(folderPath: string): Promise<number> {
		let totalSize = 0

		for await (const { fullPath } of walkContextFiles(folderPath, 2)) {
			try {
				const stats = await fs.stat(fullPath)
				totalSize += stats.size
			} catch {
				// Skip unreadable files
			}
		}

		return totalSize
	}

	/**
	 * Format bytes to human readable format
	 */
	function formatBytes(bytes: number): string {
		if (bytes === 0) return "0 Bytes"
		const k = 1024
		const sizes = ["Bytes", "KB", "MB", "GB"]
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / k ** i).toFixed(2)) + " " + sizes[i]
	}

	/**
	 * Generate combined rule content from files in a context folder
	 */
	async function generateRuleContent(folderPath: string): Promise<string> {
		const folderName = path.basename(folderPath)
		const parts: string[] = []
		let fileCount = 0
		let totalSize = 0

		// Calculate size first
		totalSize = await calculateFolderSize(folderPath)

		for await (const { relativePath, fullPath } of walkContextFiles(folderPath, 2)) {
			try {
				const content = await fs.readFile(fullPath, "utf-8")
				const stats = await fs.stat(fullPath)
				const fileSize = formatBytes(stats.size)
				parts.push(`\n## ${relativePath} (${fileSize})\n\n${content.trim()}`)
				fileCount++
			} catch {
				// Skip unreadable files
			}
		}

		const formattedSize = formatBytes(totalSize)

		if (fileCount === 0) {
			return `# Context from ${folderName}/\n\n> Estimated size: ${formattedSize} | 0 files\n\n_No supported files found. Scans for \`.md .txt .mdc .json\` up to 2 subdirectories._\n`
		}

		return `# Context from ${folderName}/\n\n> Estimated size: ${formattedSize} | ${fileCount} files\n\n> Auto-generated from files in \`${folderName}/\`. Edits will be overwritten on refresh.\n${parts.join("\n")}\n`
	}

	const workspaceRulesDir = path.join(workingDirectory, ".cline", "rules")
	await fs.mkdir(workspaceRulesDir, { recursive: true })

	const localToggles: ClineRulesToggles = controller.stateManager.getWorkspaceStateKey("localClineRulesToggles") ?? {}

	for (const folderName of CONTEXT_FOLDERS) {
		const folderPath = path.join(workingDirectory, folderName)
		const generatedFileName = `${GENERATED_PREFIX}${folderName}.md`
		const generatedFilePath = path.join(workspaceRulesDir, generatedFileName)

		const folderExists = await fileExistsAtPath(folderPath)
		const fileExists = await fileExistsAtPath(generatedFilePath)

		if (!folderExists) {
			if (fileExists) {
				// Clean up orphaned generated file
				await fs.unlink(generatedFilePath)
				if (generatedFilePath in localToggles) {
					delete localToggles[generatedFilePath]
				}
			}
			continue
		}

		// Generate or update rule file
		const content = await generateRuleContent(folderPath)
		await fs.writeFile(generatedFilePath, content, "utf-8")

		// Ensure new generated files start disabled (opt-in)
		if (!(generatedFilePath in localToggles)) {
			localToggles[generatedFilePath] = false
		}
	}

	await controller.stateManager.setWorkspaceState("localClineRulesToggles", localToggles)
}
