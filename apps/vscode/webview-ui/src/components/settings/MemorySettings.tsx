import { PLINY_REPO_MEMORY_URI, PLINY_USER_MEMORY_URI } from "@shared/pliny"
import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useEffect, useState } from "react"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient } from "@/services/grpc-client"
import { updateSetting } from "./utils/settingsHandlers"

const DEFAULT_MAX_TOKENS = 4000
/** Matches MAX_MEMORY_MAX_TOKENS in src/hosts/vscode/memory-settings.ts. */
const MAX_MAX_TOKENS = 64_000

function openMemoryFile(uri: string) {
	FileServiceClient.openFile(StringRequest.create({ value: uri })).catch((err) =>
		console.error("Failed to open the memory file:", err),
	)
}

function ToggleRow({
	id,
	label,
	checked,
	onChange,
	disabled,
	children,
}: {
	id: string
	label: string
	checked: boolean
	onChange: (checked: boolean) => void
	disabled?: boolean
	children: ReactNode
}) {
	return (
		<div className="flex flex-col gap-2 py-3">
			<div className="flex items-center justify-between w-full">
				<label htmlFor={id}>{label}</label>
				<Switch checked={checked} className="shrink-0" disabled={disabled} id={id} onCheckedChange={onChange} size="lg" />
			</div>
			<div className="text-xs text-description">{children}</div>
		</div>
	)
}

/**
 * The `plinycode.memory.*` settings (docs/memory.md): the memory budget, the
 * end-of-run proposals, past-conversation search, and links to the files.
 */
const MemorySettings = () => {
	const { memoryMaxTokens, memoryDistillEnabled, memoryConversationSearchEnabled } = useExtensionState()
	const budget = memoryMaxTokens ?? DEFAULT_MAX_TOKENS
	const memoryOn = budget > 0
	const [inputValue, setInputValue] = useState(String(budget))
	const [inputError, setInputError] = useState<string | null>(null)

	// Follow changes made in VS Code's settings without rewriting what is being typed.
	useEffect(() => {
		setInputValue((current) => (Number.parseInt(current, 10) === budget ? current : String(budget)))
	}, [budget])

	const handleBudget = (value: string) => {
		setInputValue(value)
		const tokens = Number(value.trim())
		if (value.trim() === "" || !Number.isInteger(tokens) || tokens < 0 || tokens > MAX_MAX_TOKENS) {
			setInputError(`Enter a whole number from 0 to ${MAX_MAX_TOKENS.toLocaleString()} (0 = memory off)`)
			return
		}
		setInputError(null)
		updateSetting("memoryMaxTokens", tokens)
	}

	return (
		<div className="flex flex-col">
			<div className="py-3">
				<label className="block mb-1" htmlFor="memory-max-tokens">
					Memory budget (tokens)
				</label>
				<VSCodeTextField
					className="w-full"
					id="memory-max-tokens"
					onBlur={() => {
						if (inputError) {
							setInputValue(String(budget))
							setInputError(null)
						}
					}}
					onInput={(event) => handleBudget((event.target as HTMLInputElement).value)}
					placeholder={String(DEFAULT_MAX_TOKENS)}
					value={inputValue}
				/>
				{inputError && <div className="text-error text-xs mt-1">{inputError}</div>}
				<p className="text-xs mt-[5px] text-description">
					How much memory each new conversation starts with: this repository's memory, and yours (at most a quarter).
					The most important entries are at the top of each file and are kept first, so a smaller budget leaves out the
					least important ones. 4000 tokens holds about 60–100 one-line memories. Set to 0 to turn memory off.
				</p>
				<p className="text-xs mt-[5px] text-description">
					<VSCodeLink
						className="inline text-inherit"
						href="#"
						onClick={(e: React.MouseEvent) => {
							e.preventDefault()
							openMemoryFile(PLINY_REPO_MEMORY_URI)
						}}>
						Open repository memory
					</VSCodeLink>
					{" · "}
					<VSCodeLink
						className="inline text-inherit"
						href="#"
						onClick={(e: React.MouseEvent) => {
							e.preventDefault()
							openMemoryFile(PLINY_USER_MEMORY_URI)
						}}>
						Open your memory
					</VSCodeLink>
				</p>
			</div>
			<ToggleRow
				checked={memoryOn && memoryDistillEnabled !== false}
				disabled={!memoryOn}
				id="memory-distill"
				label="Propose memories after a run"
				onChange={(checked) => updateSetting("memoryDistillEnabled", checked)}>
				After an Agent-mode run that edited files, a free model suggests what is worth remembering. Nothing is saved until
				you pick the items and press Save. <code>/distill</code> works either way.
			</ToggleRow>
			<ToggleRow
				checked={memoryConversationSearchEnabled !== false}
				id="memory-conversation-search"
				label="Search earlier conversations"
				onChange={(checked) => updateSetting("memoryConversationSearchEnabled", checked)}>
				Let the agent search and read your past conversations, for example when you mention earlier work. The search index
				is kept on this machine.
			</ToggleRow>
		</div>
	)
}

export default MemorySettings
