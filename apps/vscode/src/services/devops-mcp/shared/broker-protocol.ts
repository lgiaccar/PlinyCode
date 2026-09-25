/**
 * Wire format between the devops-mcp server process and the token broker in the
 * PlinyCode extension host. One JSON object per line, one request per connection.
 *
 * The broker lets the server use the editor's own GitHub / Microsoft sign-in
 * (vscode.authentication) although it runs in a separate process.
 */

export const BROKER_PATH_ENV = "DEVOPS_MCP_BROKER"
export const BROKER_SECRET_ENV = "DEVOPS_MCP_BROKER_SECRET"

export interface BrokerRequest {
	secret: string
	provider: "github" | "ado"
	/** Git host, e.g. github.com or a GitHub Enterprise host. */
	host: string
	/** When true the editor may show its sign-in prompt; otherwise only existing sessions are used. */
	interactive: boolean
}

export type BrokerResponse = { token: string } | { error: string }

/** Entra resource ID of Azure DevOps; tokens for it work against the Azure DevOps REST API. */
export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798"
