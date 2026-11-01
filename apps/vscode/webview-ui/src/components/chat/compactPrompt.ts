/** Display limits only: the complete prompt is always retained and sent. */
export function wordCount(text: string): number {
	return text.match(/\S+/gu)?.length ?? 0
}

export function isLongPrompt(text: string): boolean {
	return text.length >= 2000 || wordCount(text) >= 300 || text.split("\n").length >= 30
}
