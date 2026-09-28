import { TabInputText, window } from "vscode"
import { GetOpenTabsRequest, GetOpenTabsResponse } from "@/shared/proto/host/window"

export async function getOpenTabs(_: GetOpenTabsRequest): Promise<GetOpenTabsResponse> {
	const openTabPaths = window.tabGroups.all
		.flatMap((group) => group.tabs)
		.map((tab) => (tab.input as TabInputText)?.uri?.fsPath)
		.filter(Boolean)

	// A file open in more than one editor group has a tab in each; list it once.
	return GetOpenTabsResponse.create({ paths: [...new Set(openTabPaths)] })
}
