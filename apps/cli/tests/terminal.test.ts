import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Terminal } from "../src/terminal";

test("pasted multiline input and follow-up prompts are preserved", async () => {
	const input = new PassThrough();
	const terminal = new Terminal(input, new PassThrough());
	try {
		const prompt = terminal.prompt();
		input.end("first\\\nsecond\n/exit\n");
		expect(await prompt).toBe("first\nsecond");
		expect(await terminal.prompt()).toBe("/exit");
		expect(await terminal.prompt()).toBeUndefined();
	} finally {
		terminal.close();
	}
});

test("typed-ahead text cannot approve an unseen tool request", async () => {
	const input = new PassThrough();
	const terminal = new Terminal(input, new PassThrough());
	try {
		input.write("yes\n");
		const approval = terminal.ask("Allow? ");
		input.write("no\n");
		expect(await approval).toBe("no");
	} finally {
		terminal.close();
	}
});
