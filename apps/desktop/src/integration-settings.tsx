import { useState } from "react";
import type { BrowserStatus } from "./browser-contracts";
import type { Project, State } from "./contracts";
import type { PrRepository } from "./pr-contracts";

export function BrowserSettings() {
	const [extensionId, setExtensionId] = useState("");
	const [status, setStatus] = useState<BrowserStatus>({ connected: false });
	const [error, setError] = useState("");
	async function run(
		type:
			| "browserPair"
			| "browserStatus"
			| "browserDisconnect"
			| "browserExtensionFolder",
	) {
		try {
			setError("");
			const result = await window.plinycode.invoke(
				type === "browserPair" ? { type, extensionId } : { type },
			);
			if (result.browser)
				setStatus((previous) =>
					type === "browserStatus"
						? { ...previous, ...result.browser }
						: (result.browser as BrowserStatus),
				);
		} catch (error) {
			setError(String(error));
		}
	}
	return (
		<section>
			<h3>Chrome / Edge browser companion</h3>
			<p>
				Load the companion folder as an unpacked extension in Chrome or Edge.
				Paste its ID here, then copy the address and token into its popup. Share
				each tab you want agents to use. Pairing lasts until Desktop exits or
				disconnects.
			</p>
			<button type="button" onClick={() => run("browserExtensionFolder")}>
				Open companion folder
			</button>
			<label>
				Browser extension ID
				<input
					value={extensionId}
					onChange={(event) => setExtensionId(event.target.value.trim())}
				/>
			</label>
			<button type="button" onClick={() => run("browserPair")}>
				Start pairing
			</button>{" "}
			<button type="button" onClick={() => run("browserStatus")}>
				Refresh connection
			</button>{" "}
			<button type="button" onClick={() => run("browserDisconnect")}>
				Disconnect browser
			</button>
			<output>
				{status.connected ? "Browser connected" : "Browser disconnected"}
			</output>
			{status.address && (
				<label>
					Pairing address
					<input readOnly value={status.address} />
				</label>
			)}
			{status.token && (
				<label>
					Pairing token
					<input
						readOnly
						type="password"
						value={status.token}
						onFocus={(event) => event.target.select()}
					/>
				</label>
			)}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}

export function PrSettings({
	project,
	onState,
}: {
	project: Project;
	onState: (state: State) => void;
}) {
	const [config, setConfig] = useState<PrRepository>(
		project.prRepository ?? {
			provider: "github",
			apiUrl: "https://api.github.com",
			owner: "",
			repository: "",
			apiVersion: "7.0",
		},
	);
	const [token, setToken] = useState("");
	const [status, setStatus] = useState("");
	async function save() {
		try {
			const result = await window.plinycode.invoke({
				type: "savePrRepository",
				id: project.id,
				repository: config,
				token: token || undefined,
			});
			onState(result.state);
			setToken("");
			setStatus(
				"PR settings saved. Provider changes without a new token clear the previous credential.",
			);
		} catch (error) {
			setStatus(String(error));
		}
	}
	return (
		<section>
			<h3>Pull request provider</h3>
			<label>
				Provider
				<select
					aria-label="PR provider"
					value={config.provider}
					onChange={(event) =>
						setConfig({
							...config,
							provider: event.target.value as PrRepository["provider"],
							apiUrl:
								event.target.value === "github"
									? "https://api.github.com"
									: "https://dev.azure.com/ORGANIZATION",
						})
					}
				>
					<option value="github">GitHub</option>
					<option value="azure">Azure DevOps cloud / Server</option>
				</select>
			</label>
			<label>
				{config.provider === "azure"
					? "Organization or collection URL"
					: "GitHub API URL"}
				<input
					value={config.apiUrl}
					onChange={(event) =>
						setConfig({ ...config, apiUrl: event.target.value })
					}
				/>
			</label>
			<label>
				{config.provider === "azure" ? "Azure project" : "GitHub owner"}
				<input
					value={config.owner}
					onChange={(event) =>
						setConfig({ ...config, owner: event.target.value })
					}
				/>
			</label>
			<label>
				Repository name
				<input
					value={config.repository}
					onChange={(event) =>
						setConfig({ ...config, repository: event.target.value })
					}
				/>
			</label>
			{config.provider === "azure" && (
				<label>
					Azure API version
					<select
						value={config.apiVersion}
						onChange={(event) =>
							setConfig({
								...config,
								apiVersion: event.target.value as PrRepository["apiVersion"],
							})
						}
					>
						{["6.0", "7.0", "7.1"].map((version) => (
							<option key={version}>{version}</option>
						))}
					</select>
				</label>
			)}
			<label>
				New provider access token
				<input
					type="password"
					value={token}
					autoComplete="off"
					onChange={(event) => setToken(event.target.value)}
					placeholder={
						project.hasPrToken
							? "Stored securely; leave blank to retain"
							: "Required for PR API calls"
					}
				/>
			</label>
			<p>
				Git push uses your existing Git credentials. Tokens are encrypted by
				Windows and used only for this provider’s API.
			</p>
			<button type="button" onClick={save}>
				Save PR settings
			</button>
			<output>{status}</output>
		</section>
	);
}
