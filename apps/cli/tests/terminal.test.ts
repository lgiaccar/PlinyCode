import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Terminal } from "../src/terminal";

test("parallel agent approvals are shown and answered one at a time", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let text = "";
	output.on("data", (chunk) => {
		text += chunk.toString();
	});
	const terminal = new Terminal(input, output);
	try {
		const first = terminal.ask("First? ");
		const second = terminal.ask("Second? ");
		expect(text).toBe("First? ");
		input.write("no\n");
		expect(await first).toBe("no");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(text).toBe("First? Second? ");
		input.write("yes\n");
		expect(await second).toBe("yes");
		const third = terminal.ask("Third? ");
		const fourth = terminal.ask("Fourth? ");
		terminal.close();
		expect(await third).toBeUndefined();
		expect(await fourth).toBeUndefined();
	} finally {
		terminal.close();
	}
});

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
