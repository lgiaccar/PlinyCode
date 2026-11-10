import type { SettingsCatalog } from "@shared/settings-catalog"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

export function DensitySetting() {
	const { uiDensity = "comfortable" } = useExtensionState()
	const [value, setValue] = useState(uiDensity)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string>()
	useEffect(() => setValue(uiDensity), [uiDensity])
	const change = async (density: "compact" | "comfortable") => {
		setPending(true)
		try {
			const current = await UiServiceClient.manageSettingsCatalog({ value: "{}" })
			const catalog: SettingsCatalog = JSON.parse(current.value)
			const setting = catalog.settings.find((entry) => entry.key === "plinycode.ui.density")
			const scope = setting?.source === "Folder" ? "folder" : setting?.source === "Workspace" ? "workspace" : "user"
			const response = await UiServiceClient.manageSettingsCatalog({
				value: JSON.stringify({
					op: "set",
					key: "plinycode.ui.density",
					scope,
					value: density,
					resourceId: catalog.resourceId,
				}),
			})
			const updated: SettingsCatalog = JSON.parse(response.value)
			setValue(
				updated.settings.find((entry) => entry.key === "plinycode.ui.density")?.value === "compact"
					? "compact"
					: "comfortable",
			)
			setError(undefined)
		} catch {
			setError("Density could not be saved. Use settings search to inspect its scope.")
		} finally {
			setPending(false)
		}
	}
	return (
		<div className="pc-controls">
			<label className="flex items-center justify-between gap-3 text-sm">
				Interface density
				<select
					aria-label="Interface density"
					disabled={pending}
					onChange={(event) => void change(event.target.value as "compact" | "comfortable")}
					value={value}>
					<option value="comfortable">Comfortable</option>
					<option value="compact">Compact</option>
				</select>
			</label>
			<p className="text-xs text-description">
				Adjusts spacing in chat, CI Board, settings and inspection cards. Saves to the currently effective scope; use
				settings search to choose a different scope.
			</p>
			{error && <p role="alert">{error}</p>}
		</div>
	)
}
