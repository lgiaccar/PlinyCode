import * as vscode from "vscode"

/** How the editor's own AI chat (not PlinyCode) can reach the server. */
export type EditorIntegration = "cursor" | "vscode" | "none"

export interface LaunchSpec {
	command: string
	args: string[]
	env: Record<string, string>
}

export const EDITOR_SERVER_NAME = "plinycode-devops"
/** Must match `contributes.mcpServerDefinitionProviders[].id` in package.json. */
const VSCODE_PROVIDER_ID = "plinycode.devops"
const LABEL = "PlinyCode DevOps"

interface CursorMcpApi {
	registerServer(config: { name: string; server: { command: string; args: string[]; env: Record<string, string> } }): void
	unregisterServer(name: string): void
}

// MCP registration was added after our VS Code 1.94 minimum. Keep the optional
// surface local so the rest of the extension is checked against the 1.94 API.
interface VscodeMcpApi {
	lm: {
		registerMcpServerDefinitionProvider(
			id: string,
			provider: { onDidChangeMcpServerDefinitions: vscode.Event<void>; provideMcpServerDefinitions(): unknown[] },
		): vscode.Disposable
	}
	McpStdioServerDefinition: new (
		label: string,
		command: string,
		args: string[],
		env: Record<string, string>,
		version: string,
	) => unknown
}

function vscodeMcpApi(): VscodeMcpApi | undefined {
	const api = vscode as unknown as { lm?: Partial<VscodeMcpApi["lm"]> } & Partial<
		Pick<VscodeMcpApi, "McpStdioServerDefinition">
	>
	return typeof api.lm?.registerMcpServerDefinitionProvider === "function" && typeof api.McpStdioServerDefinition === "function"
		? (api as VscodeMcpApi)
		: undefined
}

function cursorMcpApi(): CursorMcpApi | undefined {
	const api = (vscode as unknown as { cursor?: { mcp?: Partial<CursorMcpApi> } }).cursor?.mcp
	return typeof api?.registerServer === "function" && typeof api.unregisterServer === "function"
		? (api as CursorMcpApi)
		: undefined
}

export function detectEditorIntegration(): EditorIntegration {
	if (cursorMcpApi()) {
		return "cursor"
	}
	// Cursor may carry the VS Code API without honouring it, so only trust it outside Cursor.
	const isCursor = vscode.env.appName.toLowerCase().includes("cursor")
	if (!isCursor && vscodeMcpApi()) {
		return "vscode"
	}
	return "none"
}

/**
 * Registers the server with the editor's own MCP support: Cursor's
 * `vscode.cursor.mcp` API, or VS Code's MCP server definition provider
 * (Copilot Chat agent mode). Returns a disposable that unregisters it.
 */
export function registerWithEditor(integration: EditorIntegration, spec: LaunchSpec, version: string): vscode.Disposable {
	if (integration === "cursor") {
		const api = cursorMcpApi() as CursorMcpApi
		api.registerServer({ name: EDITOR_SERVER_NAME, server: spec })
		return new vscode.Disposable(() => {
			try {
				api.unregisterServer(EDITOR_SERVER_NAME)
			} catch {
				// The editor is shutting down.
			}
		})
	}
	if (integration === "vscode") {
		const api = vscodeMcpApi()
		if (!api) {
			return new vscode.Disposable(() => {})
		}
		const changed = new vscode.EventEmitter<void>()
		const registration = api.lm.registerMcpServerDefinitionProvider(VSCODE_PROVIDER_ID, {
			onDidChangeMcpServerDefinitions: changed.event,
			provideMcpServerDefinitions: () => [
				new api.McpStdioServerDefinition(LABEL, spec.command, spec.args, spec.env, version),
			],
		})
		return vscode.Disposable.from(registration, changed)
	}
	return new vscode.Disposable(() => {})
}
