import { BooleanRequest, EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import type { DevOpsServerStatus } from "@shared/proto/cline/mcp"
import { NewTaskRequest } from "@shared/proto/cline/task"
import { CopyIcon, PlayIcon, RefreshCcwIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient, McpServiceClient, TaskServiceClient } from "@/services/grpc-client"

const STATE_LABEL: Record<string, string> = {
	running: "Running",
	starting: "Starting…",
	error: "Error",
	off: "Off",
}

const EXAMPLES = ["Open a PR for this branch with a summary of the changes", "Why did the last pipeline run fail?"]

/** Read-only smoke test, used by "Try in PlinyCode" and copied for the editor's own chat. */
export const TEST_PROMPT =
	'Use the plinycode-devops MCP tools (not the terminal): call repo_context for this workspace, then pipeline_runs with branch "*" and limit 5. Summarize the repository, the current branch, any open PR and the latest runs in a short table.'

/** Live status of the built-in DevOps server; undefined until the extension has answered. */
export function useDevOpsServerStatus(): DevOpsServerStatus | undefined {
	const [status, setStatus] = useState<DevOpsServerStatus>()
	useEffect(() => {
		const unsubscribe = McpServiceClient.subscribeToDevOpsServer(EmptyRequest.create({}), {
			onResponse: (response: DevOpsServerStatus) => setStatus(response),
			onError: (error: unknown) => console.error("Error in DevOps server subscription:", error),
			onComplete: () => {},
		})
		return unsubscribe
	}, [])
	return status
}

/**
 * The built-in PlinyCode DevOps MCP server: status, on/off, restart, and how to
 * use the same server from the editor's own AI chat (Copilot Chat, Cursor).
 * `compact` is the one-line row used in the chat input's MCP popup.
 */
const DevOpsServerCard = ({ status, compact = false }: { status: DevOpsServerStatus; compact?: boolean }) => {
	const { navigateToChat } = useExtensionState()
	const [expanded, setExpanded] = useState(false)
	const [busy, setBusy] = useState(false)

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

	const tryInPlinyCode = () =>
		run(async () => {
			await TaskServiceClient.newTask(NewTaskRequest.create({ text: TEST_PROMPT, images: [] }))
			navigateToChat()
		})

	const summary =
		status.state === "running"
			? `${STATE_LABEL.running} · ${status.tools.length} tools${compact || expanded ? "" : " · click for setup and testing"}`
			: status.state === "error"
				? (status.error ?? STATE_LABEL.error)
				: STATE_LABEL[status.state]

	return (
		<div className="mb-2.5">
			<div
				className={cn("flex bg-code-block-background p-2 gap-4 items-center", { "cursor-pointer": !compact })}
				onClick={() => !compact && setExpanded(!expanded)}>
				{!compact && <span className={cn("mr-2 codicon", expanded ? "codicon-chevron-down" : "codicon-chevron-right")} />}
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
					disabled={busy || status.state !== "running"}
					onClick={(e) => {
						e.stopPropagation()
						tryInPlinyCode()
					}}
					size="icon"
					title="Try it in PlinyCode (read-only: repository, branch and latest CI runs)"
					variant="icon">
					<PlayIcon />
				</Button>
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

			{expanded && !compact && (
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

					<div>
						<div className="font-medium mb-1">Try it</div>
						<p className="m-0 mb-2 text-description">
							A read-only check: it shows the repository, the current branch and the latest CI runs, and changes
							nothing. PlinyCode shows each call as an MCP tool row in the chat.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button disabled={busy || status.state !== "running"} onClick={tryInPlinyCode}>
								<PlayIcon className="mr-1.5 size-3.5" />
								Try in PlinyCode
							</Button>
							{status.integration !== "none" && (
								<Button
									disabled={busy}
									onClick={() =>
										run(() => FileServiceClient.copyToClipboard(StringRequest.create({ value: TEST_PROMPT })))
									}
									title={`Paste it into ${status.editor}'s agent chat`}
									variant="secondary">
									<CopyIcon className="mr-1.5 size-3.5" />
									Copy prompt for {status.integration === "cursor" ? "Cursor" : "Copilot Chat"}
								</Button>
							)}
						</div>
					</div>

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
					It's already registered with Cursor as <code>plinycode-devops</code>. To see it, open <b>Cursor Settings</b>{" "}
					(gear icon at the top right, or <b>Ctrl+Shift+J</b>) → <b>Customize</b> → <b>MCPs</b> (older Cursor versions:{" "}
					<b>Tools &amp; MCP</b>). Switch it on if it's off.
				</li>
				<li>
					Click <b>Copy prompt for Cursor</b> above, open Cursor's chat (<b>Ctrl+L</b> / <b>Cmd+L</b>) in <b>Agent</b>{" "}
					mode, and paste it.
				</li>
				<li>Allow the tool calls when Cursor asks. The answer shows this repository and its latest CI runs.</li>
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
					Click <b>Copy prompt for Copilot Chat</b> above, paste it into the chat and allow the tool calls.
				</li>
				<li>
					<b>MCP: List Servers</b> in the Command Palette starts, stops or shows the output of the server.
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
