/**
 * The short reference shown next to a conversation's title (`#ab3dx`), so a
 * conversation can be named in a message or a bug report and found again.
 *
 * Conversation ids look like `<ms since epoch>_<5 random characters>`; the
 * random part is the reference. Ids without one (older conversations) use the
 * last 6 letters or digits of the id.
 */
export function conversationRef(id: string): string {
	const part = id.split("_").pop() ?? id
	const alphanumeric = (part.length >= 4 ? part : id).replace(/[^a-z0-9]/gi, "")
	return alphanumeric.slice(-6).toLowerCase()
}
