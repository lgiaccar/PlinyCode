import React from "react"
import { composeScheduleTime, REPEAT_UNITS, type RepeatUnit, scheduleTimeParts } from "./scheduleTime"

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

const INPUT_CLASS = "h-7 rounded-[3px] border border-editor-group-border px-2 text-xs focus:outline-none"
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
				className={`${INPUT_CLASS} w-36`}
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
			<span className="text-xs text-description">:</span>
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

interface ScheduleRepeatInputProps {
	count: number
	every: number
	unit: RepeatUnit
	onCountChange: (count: number) => void
	onEveryChange: (every: number) => void
	onUnitChange: (unit: RepeatUnit) => void
}

const toPositiveInt = (raw: string) => Math.max(1, Math.floor(Number(raw)) || 1)

/** Repeat controls for a scheduled prompt: number of sends (1 = once) and the gap between them. */
export const ScheduleRepeatInput: React.FC<ScheduleRepeatInputProps> = ({
	count,
	every,
	unit,
	onCountChange,
	onEveryChange,
	onUnitChange,
}) => (
	<>
		<label className="flex items-center gap-1 text-xs text-description">
			Repeat
			<input
				aria-label="Number of sends"
				className={`${INPUT_CLASS} w-16`}
				min={1}
				onChange={(e) => onCountChange(toPositiveInt(e.target.value))}
				style={INPUT_STYLE}
				type="number"
				value={count}
			/>
			×
		</label>
		{count > 1 && (
			<label className="flex items-center gap-1 text-xs text-description">
				every
				<input
					aria-label="Repeat interval"
					className={`${INPUT_CLASS} w-16`}
					min={1}
					onChange={(e) => onEveryChange(toPositiveInt(e.target.value))}
					style={INPUT_STYLE}
					type="number"
					value={every}
				/>
				<select
					aria-label="Repeat interval unit"
					className={INPUT_CLASS}
					onChange={(e) => onUnitChange(e.target.value as RepeatUnit)}
					style={INPUT_STYLE}
					value={unit}>
					{(Object.keys(REPEAT_UNITS) as RepeatUnit[]).map((u) => (
						<option key={u} value={u}>
							{u}
						</option>
					))}
				</select>
			</label>
		)}
	</>
)

export default ScheduleTimeInput
