import { ClockIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { formatDuration, formatStartTime } from "@/utils/format"

interface TaskRunningTimeProps {
	/** When the conversation started (ms since epoch). */
	startedTs?: number
	/** Running time of finished runs (ms). */
	activeMs?: number
	/** When the run in progress started; the badge ticks while it is set. */
	runningSinceTs?: number
}

/** Agent running time for the conversation, with its start time in the tooltip. */
const TaskRunningTime = ({ startedTs, activeMs = 0, runningSinceTs }: TaskRunningTimeProps) => {
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (runningSinceTs === undefined) {
			return
		}
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [runningSinceTs])

	const totalMs = activeMs + (runningSinceTs !== undefined ? Math.max(0, now - runningSinceTs) : 0)
	if (!startedTs && totalMs <= 0) {
		return null
	}

	const label = `${startedTs ? `Started ${formatStartTime(startedTs)}` : ""}${startedTs && totalMs > 0 ? " · " : ""}${
		totalMs > 0 ? `agent running time ${formatDuration(totalMs)}` : ""
	}`

	return (
		<div
			aria-label={label}
			className="mx-1 inline-flex shrink-0 items-center gap-1 text-xs text-description tabular-nums"
			title={label}>
			<ClockIcon className="opacity-70" size={11} />
			<span>{totalMs > 0 ? formatDuration(totalMs) : formatStartTime(startedTs ?? 0)}</span>
		</div>
	)
}

export default TaskRunningTime
