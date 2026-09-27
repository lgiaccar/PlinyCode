import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

/** `plinycode.spending.conversationLimit`: the budget new conversations start with, in USD; 0 = no limit. */
const SpendingLimitSetting: React.FC = () => {
	const { conversationSpendingLimit } = useExtensionState()
	const limit = conversationSpendingLimit ?? 5
	const [inputValue, setInputValue] = useState(String(limit))
	const [inputError, setInputError] = useState<string | null>(null)

	// Follow outside changes (e.g. edited in VS Code settings) without
	// rewriting what the user is typing: "1." already parses to the limit.
	useEffect(() => {
		setInputValue((current) => (Number.parseFloat(current) === limit ? current : String(limit)))
	}, [limit])

	const handleChange = (event: Event) => {
		const value = (event.target as HTMLInputElement).value
		setInputValue(value)
		const dollars = Number.parseFloat(value)
		if (value.trim() === "" || Number.isNaN(dollars) || dollars < 0) {
			setInputError("Enter an amount of 0 or more (0 = no limit)")
			return
		}
		setInputError(null)
		updateSetting("conversationSpendingLimit", dollars)
	}

	return (
		<div className="mb-[15px]">
			<label className="font-medium block mb-1" htmlFor="conversation-spending-limit">
				Default conversation budget (USD)
			</label>
			<VSCodeTextField
				className="w-full"
				id="conversation-spending-limit"
				onBlur={() => {
					if (inputError) {
						setInputValue(String(limit))
						setInputError(null)
					}
				}}
				onInput={(event) => handleChange(event as Event)}
				placeholder="5"
				value={inputValue}
			/>
			{inputError && <div className="text-error text-xs mt-1">{inputError}</div>}
			<p className="text-sm mt-[5px] text-description">
				The budget each new conversation starts with. The task header shows a conversation's cost against its budget, and
				you can change a single conversation's budget there. When a conversation reaches its budget, PlinyCode pauses
				before the next model call; send a message to continue, which raises its budget by this amount. Free models are
				never limited. Set to 0 for no limit.
			</p>
		</div>
	)
}

export default SpendingLimitSetting
