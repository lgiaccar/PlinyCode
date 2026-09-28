import React from "react"

function formatResetsAt(resetsAt?: string): string | null {
	if (!resetsAt) return null
	try {
		const date = new Date(resetsAt)
		if (isNaN(date.getTime())) return null
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		})
	} catch {
		return null
	}
}

interface SpendLimitErrorProps {
	/** Human-readable error message from the backend */
	message: string
	/** Which period the limit applies to: "daily" | "monthly" */
	budgetPeriod?: string
	/** The configured spend limit in USD */
	limitUsd?: number
	/** How much the user has spent in USD this period */
	spentUsd?: number
	/** ISO 8601 timestamp of when the limit resets (may be null for monthly) */
	resetsAt?: string
}

const SpendLimitError: React.FC<SpendLimitErrorProps> = ({ message, budgetPeriod, limitUsd, spentUsd, resetsAt }) => {
	const displayMessage =
		limitUsd != null && budgetPeriod ? `$${limitUsd.toFixed(2)} ${budgetPeriod} limit has been reached.` : message

	const periodLabel = budgetPeriod ? budgetPeriod.charAt(0).toUpperCase() + budgetPeriod.slice(1) : ""
	const resetsAtFormatted = formatResetsAt(resetsAt)

	return (
		<div className="border-none rounded-md mb-2 bg-(--vscode-textBlockQuote-background)" style={{ padding: "10px 12px" }}>
			<div className="mb-3">
				<div className="text-error mb-2" style={{ fontSize: "calc(var(--vscode-font-size) + 2px)" }}>
					{displayMessage}
				</div>

				<div className="mb-3">
					{spentUsd != null && limitUsd != null && (
						<div className="text-foreground" style={{ fontSize: "var(--vscode-font-size)", lineHeight: 1.3 }}>
							{periodLabel ? `${periodLabel} usage` : "Usage"}:{" "}
							<span className="font-bold">
								${spentUsd.toFixed(2)} / ${limitUsd.toFixed(2)}
							</span>
						</div>
					)}

					{resetsAtFormatted && (
						<div className="text-foreground" style={{ fontSize: "var(--vscode-font-size)", lineHeight: 1.3 }}>
							Resets: <span className="font-bold">{resetsAtFormatted}</span>
						</div>
					)}

					<div className="text-(--vscode-descriptionForeground) mt-2 text-xs inline-flex items-center">
						<span className="codicon codicon-organization mr-1" />
						Limits set by your organization.
					</div>
				</div>
			</div>
		</div>
	)
}

export default SpendLimitError
