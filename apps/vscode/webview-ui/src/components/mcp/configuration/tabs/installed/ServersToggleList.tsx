import { McpServer } from "@shared/mcp"
import DevOpsServerCard, { useDevOpsServerStatus } from "./DevOpsServerCard"
import ServerRow from "./server-row/ServerRow"

const ServersToggleList = ({
	servers,
	isExpandable,
	hasTrashIcon,
	listGap = "medium",
}: {
	servers: McpServer[]
	isExpandable: boolean
	hasTrashIcon: boolean
	listGap?: "small" | "medium" | "large"
}) => {
	// The built-in DevOps server isn't in the user's MCP settings, so it isn't in
	// `servers`; it's listed first wherever the server list appears.
	const devOpsStatus = useDevOpsServerStatus()

	const gapClasses = {
		small: "gap-0",
		medium: "gap-2.5",
		large: "gap-5",
	}

	const gapClass = gapClasses[listGap]

	return (
		<div className={`flex flex-col ${gapClass}`}>
			{devOpsStatus && <DevOpsServerCard compact={!isExpandable} status={devOpsStatus} />}
			{servers.map((server) => (
				<ServerRow hasTrashIcon={hasTrashIcon} isExpandable={isExpandable} key={server.name} server={server} />
			))}
			{servers.length === 0 && (
				<div className="flex flex-col items-center gap-3 my-5 text-(--vscode-descriptionForeground)">
					{devOpsStatus ? "No other MCP servers installed" : "No MCP servers installed"}
				</div>
			)}
		</div>
	)
}

export default ServersToggleList
