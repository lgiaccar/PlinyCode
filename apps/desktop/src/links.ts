/** Only web URLs are handed to the OS. Never dispatch arbitrary protocol handlers. */
export function webLink(value: string): string | undefined {
	if (
		value.length > 8192 ||
		[...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
	)
		return;
	try {
		const url = new URL(value);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return;
		return url.href;
	} catch {
		return;
	}
}
