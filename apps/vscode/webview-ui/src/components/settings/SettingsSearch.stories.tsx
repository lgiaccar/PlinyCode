import type { SettingsCatalog } from "@shared/settings-catalog"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { UiServiceClient } from "@/services/grpc-client"
import { SettingsSearch } from "./SettingsSearch"

const catalog: SettingsCatalog = {
	workspace: true,
	folder: true,
	resource: "/workspace/PlinyCode",
	resourceId: "file:///workspace/PlinyCode",
	settings: [
		{
			key: "plinycode.chat.fontSize",
			description: "Font size used in the conversation. Zero follows the editor.",
			type: "number",
			value: 14,
			defaultValue: 0,
			source: "User",
			configuredScopes: ["user"],
			editable: true,
			minimum: 0,
			maximum: 30,
		},
		{
			key: "plinycode.trace.enabled",
			description: "Record conversation traces for diagnostics.",
			type: "boolean",
			value: true,
			defaultValue: true,
			source: "Default",
			configuredScopes: [],
			editable: true,
		},
		{
			key: "plinycode.router.images",
			description: "How the router handles images when a model cannot see them.",
			type: "string",
			value: "off",
			defaultValue: "off",
			source: "Workspace",
			configuredScopes: ["workspace"],
			editable: true,
			enum: ["off", "describe"],
		},
	],
}

function Preview() {
	const [ready, setReady] = useState(false)
	useEffect(() => {
		const old = UiServiceClient.manageSettingsCatalog
		UiServiceClient.manageSettingsCatalog = async () => ({ value: JSON.stringify(catalog) })
		setReady(true)
		return () => {
			UiServiceClient.manageSettingsCatalog = old
		}
	}, [])
	return (
		<div className="h-screen flex flex-col bg-sidebar-background">
			<h2 className="px-4 text-base">Settings</h2>
			{ready && <SettingsSearch onNavigate={() => {}} onSearchingChange={() => {}} />}
		</div>
	)
}
export default { title: "PlinyCode/Searchable settings", component: Preview } satisfies Meta<typeof Preview>
export const Search: StoryObj<typeof Preview> = {}
