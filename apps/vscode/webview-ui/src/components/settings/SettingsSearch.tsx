import { type CatalogSetting, matchesSetting, type SettingScope, type SettingsCatalog } from "@shared/settings-catalog"
import { useCallback, useEffect, useState } from "react"
import { UiServiceClient } from "@/services/grpc-client"

const sections = [
	{
		id: "api-config",
		label: "API configuration",
		keywords: "model provider key authentication paid models thinking effort context",
	},
	{ id: "router", label: "Router", keywords: "free auto balance model order compaction tuning fallback" },
	{ id: "features", label: "Features", keywords: "checkpoints memory web search approvals browser" },
	{ id: "terminal", label: "Terminal", keywords: "shell timeout execution profile output" },
	{ id: "general", label: "General", keywords: "appearance font display language notifications telemetry" },
	{ id: "about", label: "About", keywords: "version updates prerelease install" },
]

export function SettingsSearch({
	onNavigate,
	onSearchingChange,
}: {
	onNavigate: (section: string) => void
	onSearchingChange: (searching: boolean) => void
}) {
	const [query, setQuery] = useState("")
	const [modified, setModified] = useState(false)
	const [browse, setBrowse] = useState(false)
	const [scope, setScope] = useState<SettingScope>("user")
	const [catalog, setCatalog] = useState<SettingsCatalog>()
	const [error, setError] = useState<string>()
	const [pending, setPending] = useState(false)
	const active = !!query.trim() || modified || browse
	useEffect(() => onSearchingChange(active), [active, onSearchingChange])
	const request = useCallback(async (operation: Record<string, unknown> = {}) => {
		setPending(true)
		try {
			const result = await UiServiceClient.manageSettingsCatalog({ value: JSON.stringify(operation) })
			setCatalog(JSON.parse(result.value))
			setError(undefined)
		} catch (error) {
			setError(error instanceof Error ? error.message : "Settings could not be loaded.")
		} finally {
			setPending(false)
		}
	}, [])
	useEffect(() => {
		void request()
	}, [request])
	const clear = () => {
		setQuery("")
		setModified(false)
		setBrowse(false)
	}
	const matches = catalog?.settings.filter((setting) => matchesSetting(setting, query, modified)) ?? []
	return (
		<div className={`pc-controls px-4 pt-3 ${active ? "flex-1 min-h-0 flex flex-col" : ""}`}>
			<div className="flex flex-wrap gap-2 items-center">
				<input
					aria-label="Search settings"
					className="flex-1 min-w-32 bg-input-background text-input-foreground border border-border rounded-sm p-2"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search settings…"
					type="search"
					value={query}
				/>
				<label className="text-xs">
					<input checked={modified} onChange={(event) => setModified(event.target.checked)} type="checkbox" /> Modified
					only
				</label>
				<button aria-pressed={browse} onClick={() => setBrowse(!browse)} type="button">
					Browse settings
				</button>
				{active && (
					<button onClick={clear} type="button">
						Clear
					</button>
				)}
			</div>
			{active && (
				<div className="overflow-auto flex-1 min-h-0 py-3">
					<div className="flex flex-wrap gap-2 items-center text-xs mb-3">
						<label>
							Edit scope{" "}
							<select
								aria-label="Edit scope"
								onChange={(event) => setScope(event.target.value as SettingScope)}
								value={scope}>
								<option value="user">User</option>
								{catalog?.workspace && <option value="workspace">Workspace</option>}
								{catalog?.folder && <option value="folder">Folder</option>}
							</select>
						</label>
						<button disabled={pending} onClick={() => void request()} type="button">
							Refresh
						</button>
					</div>
					<p className="text-xs text-description">
						Effective editor settings{catalog?.resource ? ` for ${catalog.resource}` : ""}. Reset removes only the
						selected scope's override. Modified means an explicit override exists.
					</p>
					{error && <p role="alert">{error}</p>}
					{!modified && (
						<div className="flex flex-wrap gap-2 mb-3">
							{sections
								.filter((section) =>
									query
										.toLowerCase()
										.trim()
										.split(/\s+/)
										.every((word) => `${section.label} ${section.keywords}`.toLowerCase().includes(word)),
								)
								.map((section) => (
									<button
										key={section.id}
										onClick={() => {
											onNavigate(section.id)
											clear()
										}}
										type="button">
										Open {section.label}
									</button>
								))}
						</div>
					)}
					{!catalog ? (
						<p role="status">{error ? "Use Refresh to try again." : "Loading settings…"}</p>
					) : (
						<>
							<p className="text-xs">
								{matches.length} editor settings found. Model, router and API-key controls are in their sections.
							</p>
							{matches.map((setting) => (
								<SettingRow
									key={`${setting.key}:${JSON.stringify(setting.value)}:${scope}`}
									onChange={(value) =>
										request({ op: "set", key: setting.key, scope, value, resourceId: catalog.resourceId })
									}
									onOpen={() => request({ op: "open", key: setting.key })}
									onReset={() =>
										request({ op: "reset", key: setting.key, scope, resourceId: catalog.resourceId })
									}
									pending={pending}
									scope={scope}
									setting={setting}
								/>
							))}
						</>
					)}
				</div>
			)}
		</div>
	)
}

function SettingRow({
	setting,
	scope,
	pending,
	onChange,
	onReset,
	onOpen,
}: {
	setting: CatalogSetting
	scope: SettingScope
	pending: boolean
	onChange: (value: unknown) => Promise<void>
	onReset: () => Promise<void>
	onOpen: () => Promise<void>
}) {
	const [draft, setDraft] = useState(String(setting.value ?? ""))
	return (
		<article className="pc-panel border border-border rounded-sm p-3 mb-2 text-xs">
			<strong className="break-words">{setting.key.replace(/^plinycode\./, "")}</strong>
			<p className="break-words text-description">{setting.description}</p>
			<div className="flex flex-wrap gap-2 items-center">
				{setting.enum ? (
					<select
						aria-label={setting.key}
						disabled={pending}
						onChange={(event) => void onChange(JSON.parse(event.target.value))}
						value={JSON.stringify(setting.value)}>
						{setting.enum.map((value) => (
							<option key={JSON.stringify(value)} value={JSON.stringify(value)}>
								{String(value)}
							</option>
						))}
					</select>
				) : setting.type === "boolean" ? (
					<label>
						<input
							aria-label={setting.key}
							checked={setting.value === true}
							disabled={pending}
							onChange={(event) => void onChange(event.target.checked)}
							type="checkbox"
						/>{" "}
						Enabled
					</label>
				) : setting.editable ? (
					<>
						<input
							aria-label={setting.key}
							className="min-w-0 flex-1 bg-input-background border border-border p-1"
							max={setting.maximum}
							min={setting.minimum}
							onChange={(event) => setDraft(event.target.value)}
							step={setting.type === "integer" ? 1 : "any"}
							type={setting.type === "string" ? "text" : "number"}
							value={draft}
						/>
						<button
							disabled={pending || (setting.type !== "string" && !draft.trim())}
							onClick={() => void onChange(setting.type === "string" ? draft : Number(draft))}
							type="button">
							Save
						</button>
					</>
				) : (
					<code className="break-all">{JSON.stringify(setting.value)}</code>
				)}
				<button
					disabled={pending || !setting.configuredScopes.includes(scope)}
					onClick={() => void onReset()}
					type="button">
					Reset {scope}
				</button>
				<button disabled={pending} onClick={() => void onOpen()} type="button">
					Open in editor
				</button>
			</div>
			<p className="text-description break-words">
				Source: {setting.source} · Default: {JSON.stringify(setting.defaultValue)}
			</p>
		</article>
	)
}
