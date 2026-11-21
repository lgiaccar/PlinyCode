import { useState } from "react";
import type { State } from "./contracts";
import type { McpServer } from "./mcp-contracts";

export function McpSettings({
	state,
	onState,
}: {
	state: State;
	onState: (state: State) => void;
}) {
	const [draft, setDraft] = useState<McpServer>(),
		[args, setArgs] = useState("[]"),
		[secrets, setSecrets] = useState(""),
		[status, setStatus] = useState(""),
		[busy, setBusy] = useState(false);
	function edit(server?: McpServer) {
		setDraft(
			server
				? { ...server }
				: {
						id: crypto.randomUUID(),
						name: "",
						type: "stdio",
						command: "",
						args: [],
						cwd: "",
						url: "",
						enabled: true,
						timeout: 30,
						hasSecrets: false,
					},
		);
		setArgs(JSON.stringify(server?.args ?? []));
		setSecrets("");
		setStatus("");
	}
	async function perform(
		action: Parameters<typeof window.plinycode.invoke>[0],
	) {
		setBusy(true);
		setStatus("");
		try {
			const result = await window.plinycode.invoke(action);
			onState(result.state);
			setStatus(
				result.mcpTools
					? `Connected. Tools: ${result.mcpTools.join(", ") || "none"}`
					: "Saved.",
			);
			return true;
		} catch (error) {
			setStatus(String(error instanceof Error ? error.message : error));
			return false;
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="mcp-settings">
			<h3>MCP servers</h3>
			<p>
				Enabled servers connect for each run. Connection tests may start the
				configured program. Changes apply to the next run.
			</p>
			{(state.mcpServers ?? []).map((server) => (
				<div className="mcp-row" key={server.id}>
					<span>
						{server.name} · {server.type} ·{" "}
						{server.enabled ? "enabled" : "disabled"}
						{server.hasSecrets ? " · encrypted credentials" : ""}
					</span>
					<button type="button" disabled={busy} onClick={() => edit(server)}>
						Edit {server.name}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							perform({
								type: "saveMcp",
								server: { ...server, enabled: !server.enabled },
							})
						}
					>
						{server.enabled ? "Disable" : "Enable"}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => perform({ type: "testMcp", id: server.id })}
					>
						Test {server.name}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => perform({ type: "removeMcp", id: server.id })}
					>
						Remove {server.name}
					</button>
				</div>
			))}
			<button type="button" disabled={busy} onClick={() => edit()}>
				Add MCP server
			</button>
			{draft && (
				<div className="mcp-editor">
					<label>
						Server name
						<input
							aria-label="MCP server name"
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
						/>
					</label>
					<label>
						Transport
						<select
							aria-label="MCP transport"
							value={draft.type}
							onChange={(e) =>
								setDraft({
									...draft,
									type: e.target.value as McpServer["type"],
								})
							}
						>
							<option value="stdio">Local process (stdio)</option>
							<option value="http">HTTP</option>
							<option value="sse">SSE</option>
						</select>
					</label>
					{draft.type === "stdio" ? (
						<>
							<label>
								Command
								<input
									aria-label="MCP command"
									value={draft.command}
									onChange={(e) =>
										setDraft({ ...draft, command: e.target.value })
									}
								/>
							</label>
							<label>
								Arguments (JSON array)
								<input
									aria-label="MCP arguments"
									value={args}
									onChange={(e) => setArgs(e.target.value)}
								/>
							</label>
							<label>
								Working folder (blank uses task folder)
								<input
									value={draft.cwd}
									onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
								/>
							</label>
						</>
					) : (
						<label>
							Endpoint
							<input
								aria-label="MCP endpoint"
								value={draft.url}
								onChange={(e) => setDraft({ ...draft, url: e.target.value })}
							/>
						</label>
					)}
					<label>
						Timeout (seconds)
						<input
							type="number"
							min="1"
							max="120"
							value={draft.timeout}
							onChange={(e) =>
								setDraft({ ...draft, timeout: Number(e.target.value) })
							}
						/>
					</label>
					<label>
						Encrypted environment and headers (JSON)
						<textarea
							aria-label="MCP encrypted values"
							value={secrets}
							placeholder={
								'{"env":{},"headers":{"Authorization":"Bearer ..."}}'
							}
							onChange={(e) => setSecrets(e.target.value)}
						/>
					</label>
					<p>
						Leave blank to keep stored credentials. Enter empty env and headers
						objects to clear them. Stored values are never displayed. Keep
						secrets out of command arguments and endpoint URLs.
					</p>
					<button
						type="button"
						disabled={busy}
						onClick={async () => {
							try {
								const parsed = JSON.parse(args);
								const values = secrets.trim() ? JSON.parse(secrets) : undefined;
								if (
									await perform({
										type: "saveMcp",
										server: { ...draft, args: parsed },
										secrets: values,
									})
								) {
									setDraft(undefined);
									setSecrets("");
								}
							} catch {
								setStatus(
									"Arguments or encrypted values contain invalid JSON.",
								);
							}
						}}
					>
						Save MCP server
					</button>
					<button
						type="button"
						onClick={() => {
							setDraft(undefined);
							setSecrets("");
						}}
					>
						Cancel edit
					</button>
				</div>
			)}
			{status && <output>{status}</output>}
		</section>
	);
}
