import type { CatalogSetting, SettingScope, SettingsCatalog } from "@shared/settings-catalog"
import * as vscode from "vscode"
import { contributes } from "../../../package.json"

interface Schema {
	type?: string
	description?: string
	markdownDescription?: string
	default?: unknown
	enum?: (string | number | boolean)[]
	minimum?: number
	maximum?: number
	pattern?: string
}
const configurations = Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration]
const schemas: Record<string, Schema> = Object.assign({}, ...configurations.map((section) => section.properties))
const targets: Record<SettingScope, vscode.ConfigurationTarget> = {
	user: vscode.ConfigurationTarget.Global,
	workspace: vscode.ConfigurationTarget.Workspace,
	folder: vscode.ConfigurationTarget.WorkspaceFolder,
}

export async function manageSettingsCatalog(input: Record<string, unknown>): Promise<SettingsCatalog> {
	const resource = vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri
	const config = vscode.workspace.getConfiguration(undefined, resource)
	const hasWorkspace = !!vscode.workspace.workspaceFile || !!vscode.workspace.workspaceFolders?.length
	const hasFolder = !!resource && !!vscode.workspace.getWorkspaceFolder(resource)
	if (input.op && input.op !== "list") {
		const key = typeof input.key === "string" ? input.key : ""
		const schema = schemas[key]
		if (!key.startsWith("plinycode.") || !schema) throw new Error("Unknown PlinyCode setting")
		if (input.op === "open") {
			await vscode.commands.executeCommand("workbench.action.openSettings", `@id:${key}`)
		} else {
			if (input.resourceId !== resource?.toString())
				throw new Error("The active settings resource changed. Refresh before editing.")
			const scope = input.scope as SettingScope
			if (!Object.hasOwn(targets, scope) || (scope === "workspace" && !hasWorkspace) || (scope === "folder" && !hasFolder))
				throw new Error("Setting scope is unavailable")
			if (input.op !== "set" && input.op !== "reset") throw new Error("Unknown settings operation")
			if (input.op === "set") validateValue(schema, input.value)
			await config.update(key, input.op === "reset" ? undefined : input.value, targets[scope], false)
		}
	}
	const settings: CatalogSetting[] = Object.entries(schemas)
		.filter(([key]) => key.startsWith("plinycode."))
		.map(([key, schema]) => {
			const inspected = config.inspect(key)
			const configuredScopes: SettingScope[] = []
			if (inspected?.globalValue !== undefined) configuredScopes.push("user")
			if (inspected?.workspaceValue !== undefined) configuredScopes.push("workspace")
			if (inspected?.workspaceFolderValue !== undefined) configuredScopes.push("folder")
			return {
				key,
				description: schema.markdownDescription ?? schema.description ?? "",
				type: schema.type ?? "",
				value: config.get(key),
				defaultValue: inspected?.defaultValue ?? schema.default,
				source:
					inspected?.workspaceFolderValue !== undefined
						? "Folder"
						: inspected?.workspaceValue !== undefined
							? "Workspace"
							: inspected?.globalValue !== undefined
								? "User"
								: "Default",
				configuredScopes,
				enum: schema.enum,
				minimum: schema.minimum,
				maximum: schema.maximum,
				editable: ["boolean", "number", "integer", "string"].includes(schema.type ?? ""),
			}
		})
	return { settings, workspace: hasWorkspace, folder: hasFolder, resource: resource?.fsPath, resourceId: resource?.toString() }
}

function validateValue(schema: Schema, value: unknown): void {
	const numeric = schema.type === "number" || schema.type === "integer"
	if (!(["boolean", "string"].includes(schema.type ?? "") || numeric) || typeof value !== (numeric ? "number" : schema.type))
		throw new Error("Invalid setting value type")
	if (schema.enum && !schema.enum.some((option) => option === value)) throw new Error("Choose one of the listed values")
	if (
		numeric &&
		(typeof value !== "number" ||
			!Number.isFinite(value) ||
			(schema.type === "integer" && !Number.isInteger(value)) ||
			(schema.minimum !== undefined && value < schema.minimum) ||
			(schema.maximum !== undefined && value > schema.maximum))
	)
		throw new Error("Setting is outside its permitted range")
	if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value))
		throw new Error("Setting does not match its required format")
}
