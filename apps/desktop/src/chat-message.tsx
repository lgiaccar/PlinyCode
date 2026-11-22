import { useState } from "react";
import Markdown from "react-markdown";
import type { Action, Message } from "./contracts";

export function ChatMessage({
	entry,
	taskId,
	busy,
	invoke,
}: {
	entry: Message;
	taskId: string;
	busy: boolean;
	invoke: (action: Action) => Promise<boolean>;
}) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(entry.text);
	const [copied, setCopied] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	return (
		<article className={`message ${entry.role}`}>
			<div className="message-heading">
				<div className="speaker">
					{entry.role === "user" ? "You" : "PlinyCode"}
				</div>
				<div className="message-actions">
					<button
						type="button"
						onClick={async () => {
							if (
								await invoke({
									type: "copyMessage",
									id: taskId,
									messageId: entry.id,
								})
							)
								setCopied(true);
						}}
					>
						{copied ? "Copied" : "Copy"}
					</button>
					{entry.role === "user" && (
						<button
							type="button"
							disabled={busy || submitting}
							onClick={() => {
								setText(entry.text);
								setEditing(true);
							}}
						>
							Edit and restart
						</button>
					)}
				</div>
			</div>
			{editing ? (
				<form
					className="message-editor"
					onSubmit={async (event) => {
						event.preventDefault();
						setSubmitting(true);
						try {
							if (
								await invoke({
									type: "restartFrom",
									id: taskId,
									messageId: entry.id,
									prompt: text,
								})
							)
								setEditing(false);
						} finally {
							setSubmitting(false);
						}
					}}
				>
					<textarea
						aria-label="Edit earlier prompt"
						value={text}
						onChange={(event) => setText(event.target.value)}
						disabled={submitting}
					/>
					<p>
						Restart replaces this prompt and removes later messages from the
						conversation. Files and external actions are not undone.
					</p>
					<button type="submit" disabled={busy || submitting || !text.trim()}>
						Restart from here
					</button>{" "}
					<button
						type="button"
						disabled={submitting}
						onClick={() => setEditing(false)}
					>
						Cancel edit
					</button>
				</form>
			) : entry.role === "user" ? (
				<div className="prompt-text">{entry.text}</div>
			) : (
				<Markdown
					components={{
						a: ({ children }) => <span>{children}</span>,
						img: ({ alt }) => <span>[Image: {alt}]</span>,
					}}
				>
					{entry.text || (busy ? "Working…" : "")}
				</Markdown>
			)}
		</article>
	);
}
