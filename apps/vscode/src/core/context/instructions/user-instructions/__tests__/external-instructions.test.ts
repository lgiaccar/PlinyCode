import { describe, it } from "bun:test"
import { expect } from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Controller } from "@/core/controller"
import { removeGeneratedContextFolderRules } from "../context-folders"
import { refreshExternalRulesToggles } from "../external-rules"
import { estimateRuleFileTokens } from "../instruction-tokens"
import { createRuleFileFilter } from "../rule-file-filter"

function makeControllerStub(initial: Record<string, Record<string, boolean>> = {}) {
	const state = new Map<string, unknown>(Object.entries(initial))
	const controller = {
		stateManager: {
			getGlobalSettingsKey: (key: string) => state.get(key) ?? {},
			getWorkspaceStateKey: (key: string) => state.get(key) ?? {},
			setGlobalState: (key: string, value: unknown) => state.set(key, value),
			setWorkspaceState: (key: string, value: unknown) => state.set(key, value),
		},
	}
	return { controller: controller as unknown as Controller, state }
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "external-instructions-"))
	try {
		await run(workspace)
	} finally {
		await fs.rm(workspace, { recursive: true, force: true })
	}
}

async function writeFile(workspace: string, relativePath: string, content: string): Promise<string> {
	const filePath = path.join(workspace, relativePath)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, content)
	return filePath
}

describe("refreshExternalRulesToggles", () => {
	it("lists Copilot, Cursor and Windsurf rule files, enabled by default", async () => {
		await withWorkspace(async (workspace) => {
			const copilot = await writeFile(workspace, ".github/copilot-instructions.md", "copilot")
			const scoped = await writeFile(workspace, ".github/instructions/api/py.instructions.md", "scoped")
			const cursorMdc = await writeFile(workspace, ".cursor/rules/frontend/react.mdc", "cursor mdc")
			const cursorMd = await writeFile(workspace, ".cursor/rules/style.md", "cursor md")
			const cursorLegacy = await writeFile(workspace, ".cursorrules", "legacy")
			const windsurf = await writeFile(workspace, ".windsurfrules", "windsurf")
			await writeFile(workspace, ".github/ISSUE_TEMPLATE/bug.md", "not a rule")

			const { controller } = makeControllerStub()
			const result = await refreshExternalRulesToggles(controller, workspace)

			expect(result.copilotLocalToggles).to.deep.equal({ [copilot]: true, [scoped]: true })
			expect(result.cursorLocalToggles).to.deep.equal({ [cursorMdc]: true, [cursorMd]: true, [cursorLegacy]: true })
			expect(result.windsurfLocalToggles).to.deep.equal({ [windsurf]: true })
		})
	})

	it("keeps a disabled toggle and prunes files that disappeared", async () => {
		await withWorkspace(async (workspace) => {
			const copilot = await writeFile(workspace, ".github/copilot-instructions.md", "copilot")
			const gone = path.join(workspace, ".github", "instructions", "gone.instructions.md")
			const { controller } = makeControllerStub({ localCopilotRulesToggles: { [copilot]: false, [gone]: true } })

			const result = await refreshExternalRulesToggles(controller, workspace)

			expect(result.copilotLocalToggles).to.deep.equal({ [copilot]: false })
		})
	})
})

describe("createRuleFileFilter", () => {
	it("rejects files switched off in any rules toggle map", () => {
		const cursorRule = path.resolve("/w/.cursor/rules/a.mdc")
		const clineRule = path.resolve("/w/.clinerules/b.md")
		const { controller } = makeControllerStub({
			localCursorRulesToggles: { [cursorRule]: false },
			globalClineRulesToggles: { [clineRule]: true },
		})
		const filter = createRuleFileFilter(controller.stateManager)

		expect(filter(cursorRule)).to.equal(false)
		expect(filter(clineRule)).to.equal(true)
		expect(filter(path.resolve("/w/AGENTS.md"))).to.equal(true)
	})

	it("reads the toggles on every call", () => {
		const rule = path.resolve("/w/.windsurfrules")
		const { controller, state } = makeControllerStub()
		const filter = createRuleFileFilter(controller.stateManager)

		expect(filter(rule)).to.equal(true)
		state.set("localWindsurfRulesToggles", { [rule]: false })
		expect(filter(rule)).to.equal(false)
	})

	it("matches Windows paths regardless of drive-letter case", () => {
		if (process.platform !== "win32") {
			return
		}
		const { controller } = makeControllerStub({ localAgentsRulesToggles: { "d:\\repo\\AGENTS.md": false } })
		expect(createRuleFileFilter(controller.stateManager)("D:\\repo\\AGENTS.md")).to.equal(false)
	})
})

describe("removeGeneratedContextFolderRules", () => {
	it("deletes generated context dumps and their toggles, keeping user rules", async () => {
		await withWorkspace(async (workspace) => {
			const generated = await writeFile(
				workspace,
				".cline/rules/pliny-context-.vscode.md",
				"# Context from .vscode/\n\n...",
			)
			const lookalike = await writeFile(workspace, ".cline/rules/pliny-context-notes.md", "My own notes")
			const { controller, state } = makeControllerStub({
				localClineRulesToggles: { [generated]: false, [lookalike]: true },
			})

			await removeGeneratedContextFolderRules(controller, workspace)

			await fs.access(generated).then(
				() => expect.fail("generated file should be removed"),
				() => {},
			)
			expect(await fs.readFile(lookalike, "utf8")).to.equal("My own notes")
			expect(state.get("localClineRulesToggles")).to.deep.equal({ [lookalike]: true })
		})
	})

	it("removes the .cline directory when only generated files lived there", async () => {
		await withWorkspace(async (workspace) => {
			await writeFile(workspace, ".cline/rules/pliny-context-.github.md", "# Context from .github/\n")
			const { controller } = makeControllerStub()

			await removeGeneratedContextFolderRules(controller, workspace)

			await fs.access(path.join(workspace, ".cline")).then(
				() => expect.fail(".cline should be removed"),
				() => {},
			)
		})
	})
})

describe("estimateRuleFileTokens", () => {
	it("estimates tokens per file across toggle maps and reports unreadable files as 0", async () => {
		await withWorkspace(async (workspace) => {
			const rule = await writeFile(workspace, "rule.md", "x".repeat(300))
			const missing = path.join(workspace, "missing.md")

			const counts = await estimateRuleFileTokens([{ [rule]: true }, { [missing]: false }])

			expect(counts[rule]).to.equal(100)
			expect(counts[missing]).to.equal(0)
		})
	})
})
