import { beforeEach, describe, expect, it, vi } from "vitest"

const editor = vi.hoisted(() => ({
	env: { appName: "Visual Studio Code" },
	lm: undefined as { registerMcpServerDefinitionProvider: ReturnType<typeof vi.fn> } | undefined,
	McpStdioServerDefinition: undefined as ReturnType<typeof vi.fn> | undefined,
	cursor: undefined as
		| { mcp: { registerServer: ReturnType<typeof vi.fn>; unregisterServer: ReturnType<typeof vi.fn> } }
		| undefined,
}))

vi.mock("vscode", () => ({
	get env() {
		return editor.env
	},
	get lm() {
		return editor.lm
	},
	get McpStdioServerDefinition() {
		return editor.McpStdioServerDefinition
	},
	get cursor() {
		return editor.cursor
	},
	Disposable: class {
		constructor(private readonly cleanup: () => void) {}
		dispose() {
			this.cleanup()
		}
		static from(...items: { dispose(): void }[]) {
			return {
				dispose: () => {
					for (const item of items) item.dispose()
				},
			}
		}
	},
	EventEmitter: class {
		event = vi.fn()
		dispose = vi.fn()
	},
}))

import { detectEditorIntegration, registerWithEditor } from "./editor-registration"

const spec = { command: "node", args: ["devops-mcp.js"], env: {} }

describe("optional editor MCP integration", () => {
	beforeEach(() => {
		editor.env.appName = "Visual Studio Code"
		editor.lm = undefined
		editor.McpStdioServerDefinition = undefined
		editor.cursor = undefined
	})

	it("leaves older editors without MCP registration usable", () => {
		expect(detectEditorIntegration()).toBe("none")
		expect(() => registerWithEditor("none", spec, "1").dispose()).not.toThrow()
		expect(() => registerWithEditor("vscode", spec, "1").dispose()).not.toThrow()
	})

	it("requires both MCP registration and the server definition constructor", () => {
		editor.lm = { registerMcpServerDefinitionProvider: vi.fn() }
		expect(detectEditorIntegration()).toBe("none")
		registerWithEditor("vscode", spec, "1").dispose()
		expect(editor.lm.registerMcpServerDefinitionProvider).not.toHaveBeenCalled()
	})

	it("registers and disposes the provider on newer VS Code hosts", () => {
		const dispose = vi.fn()
		editor.lm = { registerMcpServerDefinitionProvider: vi.fn(() => ({ dispose })) }
		editor.McpStdioServerDefinition = vi.fn(
			class {
				constructor(
					public label: string,
					public command: string,
					public args: string[],
					public env: Record<string, string>,
					public version: string,
				) {}
			},
		)
		expect(detectEditorIntegration()).toBe("vscode")
		const registration = registerWithEditor("vscode", spec, "1")
		const [id, provider] = editor.lm.registerMcpServerDefinitionProvider.mock.calls[0]
		expect(id).toBe("plinycode.devops")
		expect(provider.provideMcpServerDefinitions()).toEqual([{ label: "PlinyCode DevOps", ...spec, version: "1" }])
		registration.dispose()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("keeps Cursor's own registration ahead of the VS Code integration", () => {
		editor.env.appName = "Cursor"
		editor.lm = { registerMcpServerDefinitionProvider: vi.fn() }
		editor.McpStdioServerDefinition = vi.fn()
		expect(detectEditorIntegration()).toBe("none")
		editor.cursor = { mcp: { registerServer: vi.fn(), unregisterServer: vi.fn() } }
		expect(detectEditorIntegration()).toBe("cursor")
		const registration = registerWithEditor("cursor", spec, "1")
		expect(editor.cursor.mcp.registerServer).toHaveBeenCalledWith({ name: "plinycode-devops", server: spec })
		registration.dispose()
		expect(editor.cursor.mcp.unregisterServer).toHaveBeenCalledWith("plinycode-devops")
		expect(editor.lm.registerMcpServerDefinitionProvider).not.toHaveBeenCalled()
	})
})
