export type SettingScope = "user" | "workspace" | "folder"
export interface CatalogSetting {
	key: string
	description: string
	type: string
	value: unknown
	defaultValue: unknown
	source: "Default" | "User" | "Workspace" | "Folder"
	configuredScopes: SettingScope[]
	enum?: (string | number | boolean)[]
	minimum?: number
	maximum?: number
	editable: boolean
}
export interface SettingsCatalog {
	settings: CatalogSetting[]
	workspace: boolean
	folder: boolean
	resource?: string
	resourceId?: string
}

export function matchesSetting(setting: CatalogSetting, query: string, modifiedOnly: boolean): boolean {
	if (modifiedOnly && setting.configuredScopes.length === 0) return false
	const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
	const text = `${setting.key} ${setting.description}`.toLocaleLowerCase()
	return words.every((word) => text.includes(word))
}
