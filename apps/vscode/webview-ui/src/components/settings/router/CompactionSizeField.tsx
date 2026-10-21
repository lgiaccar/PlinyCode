import {
	compactionSizeTokens,
	type RouterCompactionNote,
	type RouterCompactionSize,
	type RouterCompactionUnit,
} from "@shared/router-tuning"
import { type ReactNode, useEffect, useId, useState } from "react"
import { INPUT_CLASS, INPUT_STYLE } from "./RouterFields"

function formatTokens(tokens: number): string {
	return `${tokens.toLocaleString("en-US")} tokens`
}

/** The typed value as a size, undefined when the field is empty, null when it is not a positive number. */
function parseSize(text: string, unit: RouterCompactionUnit): RouterCompactionSize | undefined | null {
	const trimmed = text.trim().replace(/[_,\s]/g, "")
	if (trimmed === "") {
		return undefined
	}
	const value = Number(trimmed.replace(/k$/i, "")) * (/k$/i.test(trimmed) && unit === "tokens" ? 1000 : 1)
	return Number.isFinite(value) && value > 0 ? { unit, value } : null
}

/**
 * A compaction size in percent or tokens. It saves on blur, on Enter and when
 * the unit changes; empty means the router's default, shown as the
 * placeholder. Out-of-range values are saved too: `notes` explains them, as
 * the user types, without blocking anything.
 */
export function CompactionSizeField({
	label,
	description,
	value,
	base,
	fallbackTokens,
	notes,
	onCommit,
}: {
	label: string
	description?: ReactNode
	value: RouterCompactionSize | undefined
	/** What a percentage is of, in tokens. */
	base: number
	/** The size used when the field is empty, for the placeholder; undefined when it is adaptive. */
	fallbackTokens?: number
	/** Notes for a size in tokens, or undefined while the field is empty. */
	notes: (tokens: number | undefined) => RouterCompactionNote[]
	onCommit: (value: RouterCompactionSize | undefined) => void
}) {
	const id = useId()
	const [unit, setUnit] = useState<RouterCompactionUnit>(value?.unit ?? "tokens")
	const [text, setText] = useState(value ? String(value.value) : "")
	// Follow a save or a reset.
	useEffect(() => {
		setUnit(value?.unit ?? "tokens")
		setText(value ? String(value.value) : "")
	}, [value])

	const typed = parseSize(text, unit)
	const tokens = typed ? compactionSizeTokens(typed, base) : undefined
	const commit = (size = parseSize(text, unit)) => {
		if (size === null) {
			return
		}
		if (size?.unit !== value?.unit || size?.value !== value?.value) {
			onCommit(size)
		}
	}
	const shownNotes = typed === null ? [] : notes(tokens)

	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-center justify-between gap-2">
				<label className="text-sm" htmlFor={id}>
					{label}
					{value && (
						<span className="ml-1 text-(--vscode-textLink-foreground)" title="Changed in Settings">
							●<span className="sr-only"> (changed in Settings)</span>
						</span>
					)}
				</label>
				<div className="flex items-center gap-1">
					<input
						className={`${INPUT_CLASS} w-28 text-right`}
						id={id}
						inputMode="decimal"
						onBlur={() => commit()}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								commit()
							}
						}}
						placeholder={
							fallbackTokens === undefined
								? "adaptive"
								: unit === "percent"
									? String(Math.round((fallbackTokens / base) * 100))
									: String(fallbackTokens)
						}
						style={INPUT_STYLE}
						value={text}
					/>
					<select
						aria-label={`${label} unit`}
						className={INPUT_CLASS}
						onChange={(event) => {
							// The same size in the other unit: 250,000 tokens of a 200k budget is 125%.
							const next = event.target.value as RouterCompactionUnit
							setUnit(next)
							if (!typed) {
								return
							}
							const converted =
								next === "percent"
									? Math.round((typed.value / base) * 1000) / 10
									: Math.round((typed.value / 100) * base)
							setText(String(converted))
							commit({ unit: next, value: converted })
						}}
						style={INPUT_STYLE}
						value={unit}>
						<option value="tokens">tokens</option>
						<option value="percent">%</option>
					</select>
				</div>
			</div>
			{typed === null && (
				<div className="text-error text-xs">Enter a positive number, or leave it empty for the default</div>
			)}
			{typed?.unit === "percent" && tokens !== undefined && (
				<div className="text-xs text-description text-right">≈ {formatTokens(tokens)}</div>
			)}
			{shownNotes.map((note) => (
				<div
					className={
						note.level === "warning" ? "text-xs text-(--vscode-editorWarning-foreground)" : "text-xs text-description"
					}
					key={note.text}
					role={note.level === "warning" ? "alert" : undefined}>
					{note.level === "warning" ? "⚠ " : ""}
					{note.text}
				</div>
			))}
			{description && <div className="text-xs text-description">{description}</div>}
		</div>
	)
}
