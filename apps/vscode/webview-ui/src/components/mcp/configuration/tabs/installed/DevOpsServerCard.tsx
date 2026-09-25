import { BooleanRequest, EmptyRequest } from "@shared/proto/cline/common"
import type { DevOpsServerStatus } from "@shared/proto/cline/mcp"
import { CopyIcon, RefreshCcwIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { McpServiceClient } from "@/services/grpc-client"

const STATE_LABEL: Record<string, string> = {
	running: "Running",
	starting: "Starting…",
	error: "Error",
	off: "Off",
}

const EXAMPLES = ["Open a PR for this branch with a summary of the changes", "Why did the last pipeline run fail?"]

/**
 * The built-in PlinyCode DevOps MCP server: status, on/off, restart, and how to
 * use the same server from the editor's own AI chat (Copilot Chat, Cursor).
 */
const DevOpsServerCard = () => {
	const [status, setStatus] = useState<DevOpsServerStatus>()
	const [expanded, setExpanded] = useState(false)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		const unsubscribe = McpServiceClient.subscribeToDevOpsServer(EmptyRequest.create({}), {
			onResponse: (response: DevOpsServerStatus) => setStatus(response),
			onError: (error: unknown) => console.error("Error in DevOps server subscription:", error),
			onComplete: () => {},
		})
		return unsubscribe
	}, [])

	if (!status) {
		return null
	}

	const run = async (action: () => Promise<DevOpsServerStatus | unknown>) => {
		setBusy(true)
		try {
			await action()
		} catch (error) {
			console.error("DevOps server action failed:", error)
		} finally {
			setBusy(false)
		}
	}

	const summary =
		status.state === "running"
			? `${STATE_LABEL.running} · ${status.tools.length} tools`
			: status.state === "error"
				? (status.error ?? STATE_LABEL.error)
				: STATE_LABEL[status.state]

	return (
		<div className="mb-4">
			<div
				className="flex bg-code-block-background p-2 gap-4 items-center cursor-pointer"
				onClick={() => setExpanded(!expanded)}>
				<span className={cn("mr-2 codicon", expanded ? "codicon-chevron-down" : "codicon-chevron-right")} />
				<span className="flex-1 min-w-0 overflow-hidden break-words whitespace-normal">
					<span className="flex items-center gap-2 font-medium">
						PlinyCode DevOps
						<span className="text-xs px-1.5 rounded-sm bg-badge-background text-badge-foreground">Built-in</span>
					</span>
					<span className={cn("block mt-0.5 text-xs", status.state === "error" ? "text-error" : "text-description")}>
						{summary}
					</span>
				</span>
				<Button
					disabled={busy || !status.enabled || status.state === "starting"}
					onClick={(e) => {
						e.stopPropagation()
						run(() => McpServiceClient.restartDevOpsServer(EmptyRequest.create({})))
					}}
					size="icon"
					title="Restart Server"
					variant="icon">
					<RefreshCcwIcon />
				</Button>
				<Switch
					checked={status.enabled}
					disabled={busy}
					onClick={(e) => {
						e.stopPropagation()
						run(() => McpServiceClient.setDevOpsServerEnabled(BooleanRequest.create({ value: !status.enabled })))
					}}
				/>
				<div
					className={cn("h-2 w-2 ml-0.5 rounded-full", {
						"bg-success": status.state === "running",
						"bg-warning": status.state === "starting",
						"bg-error": status.state === "error",
						"bg-description": status.state === "off",
					})}
				/>
			</div>

			{expanded && (
				<div className="bg-code-block-background px-3 pb-3 pt-1 text-sm flex flex-col gap-3">
					<p className="m-0 text-description">
						Creates and updates pull requests and reports CI pipeline runs, on GitHub and Azure DevOps. The repository
						is picked from the workspace's git remote. Try:{" "}
						{EXAMPLES.map((example, i) => (
							<span key={example}>
								{i > 0 && " or "}
								<em>"{example}"</em>
							</span>
						))}
						.
					</p>

					{status.tools.length > 0 && (
						<div className="flex flex-wrap gap-1">
							{status.tools.map((tool) => (
								<code className="text-xs px-1.5 py-0.5 rounded-sm bg-text-block-background" key={tool}>
									{tool}
								</code>
							))}
						</div>
					)}

					<div>
						<div className="font-medium mb-1">Sign-in</div>
						<p className="m-0 text-description">
							The first time a tool needs GitHub or Azure DevOps, the editor asks you to sign in with your GitHub or
							Microsoft work account. An existing <code>gh auth login</code> / <code>az login</code>, or a{" "}
							<code>GITHUB_TOKEN</code> / <code>AZURE_DEVOPS_PAT</code> environment variable, works too.
						</p>
					</div>

					<div>
						<div className="font-medium mb-1">Use it in {status.editor || "the editor"}'s own chat</div>
						<EditorInstructions status={status} />
					</div>

					<div>
						<div className="font-medium mb-1">Other MCP clients</div>
						<p className="m-0 mb-2 text-description">
							Copy a ready-made config and paste the entry into the client's <code>mcpServers</code> file (for
							example <code>~/.cursor/mcp.json</code>). It runs this same server; sign-in there uses <code>gh</code>{" "}
							/ <code>az</code> or the environment variables above.
						</p>
						<Button
							disabled={busy || !status.enabled}
							onClick={() => run(() => McpServiceClient.copyDevOpsServerConfig(EmptyRequest.create({})))}
							variant="secondary">
							<CopyIcon className="mr-1.5 size-3.5" />
							Copy MCP config
						</Button>
					</div>
				</div>
			)}
		</div>
	)
}

const EditorInstructions = ({ status }: { status: DevOpsServerStatus }) => {
	if (!status.enabled) {
		return <p className="m-0 text-description">Turn the server on to offer it to the editor's chat.</p>
	}
	if (!status.registerWithEditor) {
		return (
			<p className="m-0 text-description">
				Off. Turn on the <code>plinycode.devops.registerWithEditor</code> setting to offer the server to the editor's
				chat.
			</p>
		)
	}
	if (status.editorError) {
		return <p className="m-0 text-error">Could not register with the editor: {status.editorError}</p>
	}
	if (status.integration === "cursor" && status.editorRegistered) {
		return (
			<ol className="m-0 pl-5 text-description">
				<li>
					It's already registered with Cursor as <code>plinycode-devops</code>.
				</li>
				<li>
					Open <b>Cursor Settings → MCP</b> (<b>Tools &amp; MCP</b> in newer versions) and check that it's switched on.
				</li>
				<li>Ask Cursor's agent, for example "open a PR for this branch".</li>
			</ol>
		)
	}
	if (status.integration === "vscode" && status.editorRegistered) {
		return (
			<ol className="m-0 pl-5 text-description">
				<li>
					It's already available to Copilot Chat as <b>PlinyCode DevOps</b>.
				</li>
				<li>
					In the Chat view, switch to <b>Agent</b> mode, click <b>Configure Tools</b> (the tools icon) and tick{" "}
					<b>PlinyCode DevOps</b>. VS Code may ask you to trust the server the first time.
				</li>
				<li>
					Or run <b>MCP: List Servers</b> from the Command Palette to start, stop or inspect it.
				</li>
			</ol>
		)
	}
	return (
		<p className="m-0 text-description">
			This editor doesn't let extensions register MCP servers. Use <b>Copy MCP config</b> below and add the entry to its MCP
			settings.
		</p>
	)
}

export default DevOpsServerCard
