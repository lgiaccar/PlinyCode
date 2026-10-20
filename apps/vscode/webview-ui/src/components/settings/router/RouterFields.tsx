import { type ReactNode, useEffect, useId, useState } from "react"
import { Switch } from "@/components/ui/switch"

export const INPUT_CLASS = "h-7 rounded-[3px] border border-editor-group-border px-2 text-xs focus:outline-none"
export const INPUT_STYLE: React.CSSProperties = {
	backgroundColor: "var(--vscode-input-background, var(--vscode-sideBar-background))",
	color: "var(--vscode-input-foreground, var(--vscode-foreground))",
}

/** A setting that differs from the rules file shows this dot next to its label. */
function TunedMark({ tuned }: { tuned: boolean }) {
	return tuned ? (
		<span className="ml-1 text-(--vscode-textLink-foreground)" title="Changed in Settings">
			●<span className="sr-only"> (changed in Settings)</span>
		</span>
	) : null
}

/**
 * A number field that saves when it loses focus or on Enter. Empty means
 * "use the rules file's value", shown as the placeholder. `scale` converts
 * between the stored unit and the one shown (1000 shows milliseconds as
 * seconds).
 */
export function NumberField({
	label,
	description,
	value,
	fallback,
	scale = 1,
	min = 1,
	integer = true,
	onCommit,
}: {
	label: string
	description?: ReactNode
	value: number | undefined
	fallback: number | undefined
	scale?: number
	min?: number
	/** Stored as a whole number (in the stored unit). */
	integer?: boolean
	onCommit: (value: number | undefined) => void
}) {
	const id = useId()
	const shown = (stored: number | undefined) => (stored === undefined ? "" : String(stored / scale))
	const [text, setText] = useState(shown(value))
	const [error, setError] = useState<string>()
	// Follow a save or a reset without rewriting what is being typed elsewhere.
	useEffect(() => {
		setText(value === undefined ? "" : String(value / scale))
		setError(undefined)
	}, [value, scale])

	const commit = () => {
		const trimmed = text.trim()
		if (trimmed === "") {
			setError(undefined)
			if (value !== undefined) {
				onCommit(undefined)
			}
			return
		}
		const number = Number(trimmed)
		if (!Number.isFinite(number) || number < min) {
			setError(`Enter a number of at least ${min}, or leave it empty for the rules file's value`)
			return
		}
		setError(undefined)
		const stored = integer ? Math.round(number * scale) : number * scale
		if (stored !== value) {
			onCommit(stored)
		}
	}

	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-center justify-between gap-2">
				<label className="text-sm" htmlFor={id}>
					{label}
					<TunedMark tuned={value !== undefined} />
				</label>
				<input
					className={`${INPUT_CLASS} w-28 text-right`}
					id={id}
					inputMode="decimal"
					onBlur={commit}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commit()
						}
					}}
					placeholder={shown(fallback)}
					style={INPUT_STYLE}
					value={text}
				/>
			</div>
			{error && <div className="text-error text-xs">{error}</div>}
			{description && <div className="text-xs text-description">{description}</div>}
		</div>
	)
}

/** A switch whose unset state follows the rules file. */
export function ToggleField({
	label,
	description,
	value,
	fallback,
	onCommit,
}: {
	label: string
	description?: ReactNode
	value: boolean | undefined
	fallback: boolean
	onCommit: (value: boolean | undefined) => void
}) {
	const id = useId()
	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-center justify-between gap-2">
				<label className="text-sm" htmlFor={id}>
					{label}
					<TunedMark tuned={value !== undefined} />
				</label>
				<Switch
					checked={value ?? fallback}
					className="shrink-0"
					id={id}
					// Back to the file's value stores nothing, so a later file edit applies again.
					onCheckedChange={(checked) => onCommit(checked === fallback ? undefined : checked)}
				/>
			</div>
			{description && <div className="text-xs text-description">{description}</div>}
		</div>
	)
}

/** A native select; the first option is the rules file's value, stored as "unset". */
export function SelectField({
	label,
	description,
	value,
	fallbackLabel,
	options,
	onCommit,
}: {
	label: string
	description?: ReactNode
	value: string | undefined
	fallbackLabel: string
	options: { value: string; label: string }[]
	onCommit: (value: string | undefined) => void
}) {
	const id = useId()
	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-center justify-between gap-2">
				<label className="text-sm" htmlFor={id}>
					{label}
					<TunedMark tuned={value !== undefined} />
				</label>
				<select
					className={`${INPUT_CLASS} max-w-[60%]`}
					id={id}
					onChange={(event) => onCommit(event.target.value || undefined)}
					style={INPUT_STYLE}
					value={value ?? ""}>
					<option value="">{fallbackLabel}</option>
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			{description && <div className="text-xs text-description">{description}</div>}
		</div>
	)
}
