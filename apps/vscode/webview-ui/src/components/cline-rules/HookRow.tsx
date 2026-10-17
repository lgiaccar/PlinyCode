import { StringRequest } from "@shared/proto/cline/common"
import { DeleteHookRequest, HooksToggles } from "@shared/proto/cline/file"
import { PenIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { FileServiceClient } from "@/services/grpc-client"

interface HookRowProps {
	hookName: string
	enabled: boolean
	absolutePath: string
	isGlobal: boolean
	workspaceName?: string
	onToggle: (newEnabled: boolean) => void
	onDelete: (hooksToggles: HooksToggles) => void
}

/** The file's name, e.g. `PreToolUse.ps1`: one event can have a hook file per directory and extension. */
function hookFileLabel(absolutePath: string, hookName: string): string {
	return absolutePath.split(/[\\/]/).pop() || hookName
}

const HookRow: React.FC<HookRowProps> = ({ hookName, enabled, absolutePath, isGlobal, workspaceName, onToggle, onDelete }) => {
	const handleEditClick = () => {
		FileServiceClient.openFile(StringRequest.create({ value: absolutePath })).catch((err) =>
			console.error("Failed to open file:", err),
		)
	}

	const handleDeleteClick = () => {
		FileServiceClient.deleteHook(
			DeleteHookRequest.create({
				hookName,
				hookPath: absolutePath,
				isGlobal,
				workspaceName,
			}),
		)
			.then((response) => {
				if (response.hooksToggles) {
					onDelete(response.hooksToggles)
				}
			})
			.catch((err) => console.error("Failed to delete hook:", err))
	}

	return (
		<div className="mb-2.5">
			<div className="flex items-center px-2 py-4 rounded bg-text-block-background max-h-4">
				<span className="flex-1 overflow-hidden break-all whitespace-normal flex items-center mr-1" title={absolutePath}>
					<span className="ph-no-capture">{hookFileLabel(absolutePath, hookName)}</span>
				</span>

				{/* Toggle Switch */}
				<div className="flex items-center space-x-2 gap-2">
					<Switch checked={enabled} className="mx-1" key={absolutePath} onClick={() => onToggle(!enabled)} />
					<Button aria-label="Edit hook file" onClick={handleEditClick} size="xs" title="Edit hook file" variant="icon">
						<PenIcon />
					</Button>
					<Button
						aria-label="Delete hook file"
						onClick={handleDeleteClick}
						size="xs"
						title="Delete hook file"
						variant="icon">
						<Trash2Icon />
					</Button>
				</div>
			</div>
		</div>
	)
}

export default HookRow
