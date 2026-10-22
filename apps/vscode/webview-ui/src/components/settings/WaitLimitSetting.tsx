import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

/** Default cumulative `wait` budget for one agent turn. */
const WaitLimitSetting = () => {
	const { maxWaitMinutesPerTurn } = useExtensionState()
	const limit = maxWaitMinutesPerTurn ?? 60
	const [value, setValue] = useState(String(limit))
	const [error, setError] = useState(false)
	useEffect(() => setValue((current) => (Number(current) === limit ? current : String(limit))), [limit])
	return (
		<div className="mb-[15px]">
			<label className="font-medium block mb-1" htmlFor="max-wait-minutes-per-turn">
				Default cumulative wait per agent turn (minutes)
			</label>
			<VSCodeTextField
				className="w-full"
				id="max-wait-minutes-per-turn"
				onBlur={() => {
					if (error) {
						setValue(String(limit))
						setError(false)
					}
				}}
				onInput={(event) => {
					const input = (event.target as HTMLInputElement).value
					setValue(input)
					const minutes = Number(input)
					const invalid = input.trim() === "" || !Number.isFinite(minutes) || minutes < 0
					setError(invalid)
					if (!invalid) updateSetting("maxWaitMinutesPerTurn", minutes)
				}}
				value={value}
			/>
			{error && <div className="text-error text-xs mt-1">Enter 0 or more minutes.</div>}
			<p className="text-sm mt-[5px] text-description">
				This counts only time spent in the agent's `wait` calls during one turn. Each call is capped at 10 minutes. Change
				one conversation's limit in its task header. Set to 0 for no cumulative limit.
			</p>
		</div>
	)
}

export default WaitLimitSetting
