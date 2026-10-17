import type { ClineMessage } from "@shared/ExtensionMessage"
import { TriangleAlertIcon } from "lucide-react"
import { type ReactNode, useState } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import ChatErrorBoundary from "./ChatErrorBoundary"

interface UndisplayableMessageRowProps {
	/** The row's message, or the messages of a grouped row. */
	message?: ClineMessage | ClineMessage[]
	/** Why it could not be displayed: a payload parse error or a render error. */
	error: string
}

function describeMessage(message: ClineMessage): string {
	const kind = message.type === "ask" ? `ask: ${message.ask}` : `say: ${message.say}`
	const partial = message.partial ? ", partial" : ""
	return `Message (${kind}, ts ${message.ts}${partial}):\n${message.text ?? "(no text)"}`
}

/** The text the details panel shows and the copy action copies. */
function formatDetails(error: string, message: ClineMessage | ClineMessage[] | undefined): string {
	const messages = message === undefined ? [] : Array.isArray(message) ? message : [message]
	return [`Error: ${error}`, ...messages.map(describeMessage)].join("\n\n")
}

/**
 * The compact row a chat message renders instead of its content when its payload
 * cannot be parsed or its renderer throws. It keeps the rest of the chat usable
 * and offers the raw text and the error, to copy into a bug report.
 */
export function UndisplayableMessageRow({ message, error }: UndisplayableMessageRowProps) {
	const [showDetails, setShowDetails] = useState(false)
	const details = formatDetails(error, message)

	return (
		<div className="py-1 text-[12px] text-description" data-testid="undisplayable-message">
			<div className="flex items-center gap-1.5">
				<TriangleAlertIcon className="size-2 shrink-0 text-warning" />
				<span className="flex-1 min-w-0">This message could not be displayed.</span>
				<button
					aria-expanded={showDetails}
					className="bg-transparent border-0 p-0 text-link cursor-pointer hover:underline"
					onClick={() => setShowDetails((value) => !value)}
					type="button">
					{showDetails ? "Hide details" : "Details"}
				</button>
				<CopyButton ariaLabel="Copy message details" textToCopy={details} />
			</div>
			{showDetails && (
				<pre className="ph-no-capture mt-1 mb-0 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-xs border border-editor-group-border bg-code p-2 text-[11px]">
					{details}
				</pre>
			)}
		</div>
	)
}

/** What a row renders from: when any of it changes, a row that threw gets another try. */
function rowResetKeys(message: ClineMessage | ClineMessage[]): unknown[] {
	const messages = Array.isArray(message) ? message : [message]
	return messages.flatMap((m) => [m.ts, m.text, m.partial, m.commandCompleted])
}

interface ChatRowErrorBoundaryProps {
	message: ClineMessage | ClineMessage[]
	children: ReactNode
}

/**
 * Contains a render error to its own chat row: the row shows the compact
 * "could not be displayed" row while its siblings render normally. Give it a
 * `key` per row (the message ts) so a row reused for another message starts
 * clean; the same row retries when its message's text changes.
 */
export function ChatRowErrorBoundary({ message, children }: ChatRowErrorBoundaryProps) {
	return (
		<ChatErrorBoundary
			fallback={(error) => (
				// The same padding ChatRow gives its content, so the row lines up with its siblings.
				<div className="pt-2.5 px-4">
					<UndisplayableMessageRow error={error.message || String(error)} message={message} />
				</div>
			)}
			resetKeys={rowResetKeys(message)}>
			{children}
		</ChatErrorBoundary>
	)
}
