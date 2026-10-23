import { PLINY_REPO_MEMORY_URI, PLINY_USER_MEMORY_URI } from "@shared/pliny"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient } from "@/services/grpc-client"
import MemoryPanel from "./MemoryPanel"
import { updateSetting } from "./utils/settingsHandlers"

export default function MemorySettings() {
	const { memoryConversationSearchEnabled } = useExtensionState()
	const [error, setError] = useState("")
	const open = (uri: string) => {
		FileServiceClient.openFile(StringRequest.create({ value: uri })).catch((reason) => setError(String(reason)))
	}
	return (
		<div className="flex flex-col gap-3">
			<div className="flex gap-2 flex-wrap">
				<Button onClick={() => open(PLINY_REPO_MEMORY_URI)} variant="secondary">
					Open repository memory
				</Button>
				<Button onClick={() => open("pliny://memory/group")} variant="secondary">
					Open group memory
				</Button>
				<Button onClick={() => open(PLINY_USER_MEMORY_URI)} variant="secondary">
					Open your memory
				</Button>
			</div>
			{error && <p role="alert">{error}</p>}
			<label className="flex justify-between gap-2" htmlFor="memory-conversation-search">
				Search earlier conversations
				<Switch
					checked={memoryConversationSearchEnabled !== false}
					id="memory-conversation-search"
					onCheckedChange={(checked) => updateSetting("memoryConversationSearchEnabled", checked)}
				/>
			</label>
			<MemoryPanel />
		</div>
	)
}
