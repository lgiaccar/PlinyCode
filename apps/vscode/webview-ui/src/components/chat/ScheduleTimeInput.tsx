import React from "react"
import { composeScheduleTime, scheduleTimeParts } from "./scheduleTime"

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

const INPUT_CLASS = "h-5 rounded-[3px] border border-editor-group-border px-1 text-[10px] focus:outline-none"
const INPUT_STYLE: React.CSSProperties = {
	backgroundColor: "var(--vscode-input-background, var(--vscode-sideBar-background))",
	color: "var(--vscode-input-foreground, var(--vscode-foreground))",
}

interface ScheduleTimeInputProps {
	value: string
	onChange: (value: string) => void
}

/** Date plus 24-hour hour/minute selects; the native time input follows the OS locale and can show AM/PM. */
const ScheduleTimeInput: React.FC<ScheduleTimeInputProps> = ({ value, onChange }) => {
	const parts = scheduleTimeParts(value)
	return (
		<>
			<input
				aria-label="Schedule date"
				className={`${INPUT_CLASS} w-24`}
				onChange={(e) => e.target.value && onChange(composeScheduleTime({ ...parts, date: e.target.value }))}
				style={INPUT_STYLE}
				type="date"
				value={parts.date}
			/>
			<select
				aria-label="Schedule hour (24-hour)"
				className={INPUT_CLASS}
				onChange={(e) => onChange(composeScheduleTime({ ...parts, hour: Number(e.target.value) }))}
				style={INPUT_STYLE}
				value={parts.hour}>
				{HOURS.map((h) => (
					<option key={h} value={h}>
						{String(h).padStart(2, "0")}
					</option>
				))}
			</select>
			<span className="text-[10px] text-description">:</span>
			<select
				aria-label="Schedule minute"
				className={INPUT_CLASS}
				onChange={(e) => onChange(composeScheduleTime({ ...parts, minute: Number(e.target.value) }))}
				style={INPUT_STYLE}
				value={parts.minute}>
				{MINUTES.map((m) => (
					<option key={m} value={m}>
						{String(m).padStart(2, "0")}
					</option>
				))}
			</select>
		</>
	)
}

export default ScheduleTimeInput
