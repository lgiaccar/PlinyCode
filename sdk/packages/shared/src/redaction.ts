export function redact(text: string, secrets: string[]): string {
	let result = text;
	for (const secret of secrets
		.filter(Boolean)
		.sort((a, b) => b.length - a.length))
		result = result.split(secret).join("[REDACTED]");
	return result.replace(/(Bearer\s+)[\w.+/-]+/gi, "$1[REDACTED]");
}

export function serialize(
	value: unknown,
	secrets: string[],
	indent?: number,
): string {
	return JSON.stringify(
		value,
		(_key, entry) =>
			typeof entry === "string" ? redact(entry, secrets) : entry,
		indent,
	);
}

/** Keep enough trailing text to redact credentials split across model chunks. */
export class StreamRedactor {
	private pending = "";
	constructor(private secrets: string[]) {}
	push(chunk: string): string {
		this.pending += chunk;
		// Hold only a suffix that could still become a secret. A fixed tail
		// length hides short progress lines indefinitely in quiet commands.
		let end = this.pending.length;
		for (const secret of this.secrets.filter(Boolean)) {
			for (
				let length = 1;
				length < secret.length && length <= this.pending.length;
				length++
			) {
				if (this.pending.endsWith(secret.slice(0, length)))
					end = Math.min(end, this.pending.length - length);
			}
		}
		for (let length = 1; length < "bearer ".length; length++) {
			if (this.pending.toLowerCase().endsWith("bearer ".slice(0, length)))
				end = Math.min(end, this.pending.length - length);
		}
		const bearer = /Bearer[ \t]+[\w.+/-]*$/i.exec(this.pending);
		if (bearer && bearer.index + bearer[0].length === this.pending.length)
			end = Math.min(end, bearer.index);
		for (const secret of this.secrets.filter(Boolean)) {
			let start = this.pending.indexOf(secret);
			while (start >= 0) {
				if (start < end && start + secret.length > end) end = start;
				start = this.pending.indexOf(secret, start + secret.length);
			}
		}
		const output = redact(this.pending.slice(0, end), this.secrets);
		this.pending = this.pending.slice(end);
		return output;
	}
	flush(): string {
		const output = redact(this.pending, this.secrets);
		this.pending = "";
		return output;
	}
}
