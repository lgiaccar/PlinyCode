import { SetTaskWaitMinutesPerTurnRequest } from "@shared/proto/cline/task"
import { useEffect, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

/** Per-conversation override of cumulative `wait` minutes per agent turn. */
export const TaskWaitLimit = ({ taskId, minutes }: { taskId: string; minutes: number }) => {
	const [value, setValue] = useState(String(minutes))
	const [editing, setEditing] = useState(false)
	useEffect(() => {
		if (!editing) setValue(String(minutes))
	}, [minutes, editing])
	return editing ? (
		<input
			aria-label="Cumulative wait limit per agent turn in minutes"
			autoFocus
			className="w-16 text-xs bg-input-background text-foreground"
			min="0"
			onBlur={() => {
				const parsed = Number(value)
				if (value.trim() && Number.isFinite(parsed) && parsed >= 0) {
					TaskServiceClient.setTaskWaitMinutesPerTurn(
						SetTaskWaitMinutesPerTurnRequest.create({ taskId, minutes: parsed }),
					).catch(console.error)
				} else setValue(String(minutes))
				setEditing(false)
			}}
			onChange={(event) => setValue(event.target.value)}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => {
				event.stopPropagation()
				if (event.key === "Enter") event.currentTarget.blur()
				if (event.key === "Escape") {
					setValue(String(minutes))
					setEditing(false)
				}
			}}
			type="number"
			value={value}
		/>
	) : (
		<button
			aria-label={`Cumulative wait per agent turn: ${minutes === 0 ? "unlimited" : `${minutes} minutes`}. Change limit`}
			className="text-xs text-description bg-transparent border-0 cursor-pointer"
			onClick={(event) => {
				event.stopPropagation()
				setEditing(true)
			}}
			title="Cumulative wait time per agent turn; 0 = unlimited. Click to change."
			type="button">
			Wait {minutes === 0 ? "∞" : `${minutes}m`}
		</button>
	)
}
