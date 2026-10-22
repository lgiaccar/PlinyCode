function ansiRegex({ onlyFirst = false } = {}) {
	// Valid string terminator sequences are BEL, ESC\, and 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)"
	// The final characters include X (erase characters), which ConPTY writes to
	// clear the rest of a row.
	const pattern = [
		`[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?${ST})`,
		"(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TXZcf-nq-uy=><~]))",
	].join("|")

	return new RegExp(pattern, onlyFirst ? undefined : "g")
}

export function stripAnsi(string: string): string {
	return string.replace(ansiRegex(), "")
}
