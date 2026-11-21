import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { CliError } from "./options";

export class Terminal {
	private readonly lines;
	private buffered: string[] = [];
	private pending?: (line: string | undefined) => void;
	private closed = false;
	constructor(
		input: Readable = process.stdin,
		private output: Writable = process.stderr,
	) {
		this.lines = createInterface({
			input,
			output,
			terminal: input === process.stdin && !!process.stdin.isTTY,
		});
		this.lines.on("line", (line) => {
			const callback = this.pending;
			this.pending = undefined;
			if (callback) callback(line);
			else this.buffered.push(line);
		});
		this.lines.on("close", () => {
			this.closed = true;
			this.pending?.(undefined);
			this.pending = undefined;
		});
		this.lines.on("SIGINT", () => process.emit("SIGINT"));
	}
	async ask(
		prompt: string,
		consumeBuffered = false,
	): Promise<string | undefined> {
		// Typed-ahead chat text must never approve a tool whose prompt was not seen.
		if (!consumeBuffered) this.buffered = [];
		this.output.write(prompt);
		if (this.buffered.length) return this.buffered.shift();
		if (this.closed) return undefined;
		return new Promise((resolve) => {
			this.pending = resolve;
		});
	}
	async prompt(): Promise<string | undefined> {
		let text = await this.ask("\nYou> ", true);
		if (text === undefined) return undefined;
		while (text.endsWith("\\")) {
			const next = await this.ask("... ", true);
			if (next === undefined) return undefined;
			text = `${text.slice(0, -1)}\n${next}`;
		}
		return text;
	}
	close() {
		this.lines.close();
	}
}

export async function readStdin(maxBytes = 8 * 1024 * 1024): Promise<string> {
	let size = 0;
	const chunks: Buffer[] = [];
	// Use the runtime's fd stream so an already-closed pipe is drained on Linux.
	const reader = Bun.stdin.stream().getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const bytes = Buffer.from(value);
			size += bytes.length;
			if (size > maxBytes)
				throw new CliError(
					"input_too_large",
					`Input exceeds ${maxBytes} bytes.`,
				);
			chunks.push(bytes);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function readPassword(): Promise<string> {
	if (!process.stdin.isTTY)
		throw new CliError(
			"invalid_arguments",
			"Use auth login --stdin for secret input from a pipe.",
		);
	process.stderr.write("Pliny API key (hidden): ");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const done = () => {
			process.stdin.off("data", onData);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stderr.write("\n");
		};
		const onData = (chunk: Buffer) => {
			for (const char of chunk.toString("utf8")) {
				if (char === "\u0003") {
					done();
					reject(new CliError("cancelled", "Cancelled.", 130));
					return;
				}
				if (char === "\r" || char === "\n") {
					done();
					resolve(value);
					return;
				}
				if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
				else if (char >= " ") value += char;
			}
		};
		process.stdin.on("data", onData);
	});
}
