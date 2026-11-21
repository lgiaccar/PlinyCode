import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { StreamRedactor } from "@plinycode/shared/node";
import { guardHostLifetime } from "./host-lifetime";

const reader = createInterface({ input: process.stdin });
guardHostLifetime(reader);
reader.once("line", (line) => {
	const input = JSON.parse(line) as {
		command: string;
		cwd: string;
		secrets: string[];
	};
	const send = (event: unknown) =>
		process.stdout.write(`${JSON.stringify(event)}\n`);
	const windows = process.platform === "win32";
	const child = spawn(
		windows ? "powershell.exe" : "/bin/sh",
		windows
			? ["-NoProfile", "-NonInteractive", "-Command", input.command]
			: ["-c", input.command],
		{ cwd: input.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	for (const output of [child.stdout, child.stderr]) {
		const decoder = new StringDecoder("utf8"),
			redactor = new StreamRedactor(input.secrets);
		output.on("data", (data) => {
			const text = redactor.push(decoder.write(data));
			if (text) send({ text });
		});
		output.on("end", () => {
			const text = redactor.push(decoder.end()) + redactor.flush();
			if (text) send({ text });
		});
	}
	child.once("error", () =>
		send({ done: true, exitCode: -1, text: "Could not start command shell." }),
	);
	child.once("close", (code) => send({ done: true, exitCode: code ?? -1 }));
});
// Keep the parent PID alive so the host can stop any surviving descendants.
setInterval(() => {}, 60_000);
