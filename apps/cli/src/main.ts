#!/usr/bin/env bun
import type { EventEmitter } from "node:events";
import { CliError, HELP, parseOptions } from "./options";
import { redact, serialize } from "./output";
import { readPassword, readStdin, Terminal } from "./terminal";

// Engine/dependency console logging must never corrupt pipeline JSON stdout.
console.log = console.error;
console.info = console.error;
const args = process.argv.slice(2);
let secrets = [process.env.PLINY_API_KEY ?? ""];
let terminal: Terminal | undefined;
let runner: import("./runner").Runner | undefined;
let exitCode = 0;
let removeSignals = () => {};
let finalOutput: string | undefined;

async function main() {
	if (args.length === 1 && args[0] === "--version") {
		const { CLI_VERSION } = await import("./version");
		process.stdout.write(`${CLI_VERSION}\n`);
		return;
	}
	if (args[0] === "update") {
		const { runUpdate } = await import("./update");
		await runUpdate(args.slice(1));
		return;
	}
	const options = parseOptions(args);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.command === "skills" || options.command === "agents") {
		const { listDiscovered } = await import("./discovery");
		await listDiscovered(options);
		return;
	}
	if (options.command === "auth") {
		const credentials = await import("./credentials");
		if (options.authAction === "login")
			await credentials.saveApiKey(
				options.stdin ? await readStdin(65536) : await readPassword(),
			);
		else if (options.authAction === "logout") await credentials.removeApiKey();
		else
			throw new CliError(
				"invalid_arguments",
				"Use auth login [--stdin] or auth logout.",
			);
		process.stderr.write(
			"Credential store updated. PLINY_API_KEY, if set, still takes precedence.\n",
		);
		return;
	}
	if (options.command === "models") {
		const {
			getModelsForProvider,
			isPlinyRouterModelId,
			PLINY_FREE_AUTO_MODEL_ID,
		} = await import("@plinycode/llms");
		const models = Object.entries(
			await getModelsForProvider("pliny", { filter: "chat" }),
		)
			.filter(
				([id]) => !isPlinyRouterModelId(id) || id === PLINY_FREE_AUTO_MODEL_ID,
			)
			.map(([id, info]) => ({ id, name: info.name }));
		process.stdout.write(
			options.json
				? `${JSON.stringify(models)}\n`
				: `${models.map((m) => `${m.id}\t${m.name ?? ""}`).join("\n")}\n`,
		);
		return;
	}
	if (options.command === "doctor") {
		const { spawnSync } = await import("node:child_process");
		const probe = (command: string, args: string[]) =>
			spawnSync(command, args, {
				windowsHide: true,
				stdio: "ignore",
				timeout: 5000,
			}).status === 0;
		const report = {
			platform: process.platform,
			arch: process.arch,
			runtime: process.version,
			bun: typeof Bun !== "undefined" ? Bun.version : undefined,
			injectedKey: !!process.env.PLINY_API_KEY,
			git: probe("git", ["--version"]),
			ripgrep: probe("rg", ["--version"]),
			secureStore:
				process.platform === "win32"
					? probe("powershell.exe", ["-NoProfile", "-Command", "exit 0"])
					: probe("secret-tool", ["--help"]),
			note: "No gateway request was made. Git and MCP-server runtimes are optional job dependencies.",
		};
		process.stdout.write(
			`${JSON.stringify(report, null, options.json ? undefined : 2)}\n`,
		);
		return;
	}
	if (
		options.command === "chat" &&
		(!process.stdin.isTTY || !process.stdout.isTTY)
	)
		throw new CliError(
			"terminal_required",
			"chat requires a terminal. Use run --stdin for pipelines.",
		);
	// Consume pipeline input before loading the engine and its dependencies.
	const stdin = options.stdin ? await readStdin() : "";
	const { buildPrompt, Runner } = await import("./runner");
	const firstPrompt =
		options.command === "run" || options.prompt || options.files.length
			? await buildPrompt(options, stdin)
			: undefined;
	const { getApiKey } = await import("./credentials");
	const key = await getApiKey();
	secrets.push(key);
	if (options.command === "chat") {
		terminal = new Terminal();
		void import("./update")
			.then(({ notifyUpdate }) => notifyUpdate())
			.catch(() => {});
	}
	const signalHandler = () => {
		terminal?.close();
		runner?.cancel();
		exitCode = 130;
	};
	process.on("SIGINT", signalHandler);
	process.on("SIGTERM", signalHandler);
	removeSignals = () => {
		(process as EventEmitter).removeListener("SIGINT", signalHandler);
		(process as EventEmitter).removeListener("SIGTERM", signalHandler);
	};
	runner = await Runner.create(options, key, terminal);
	secrets = runner.secrets;
	if (exitCode === 130) throw new CliError("cancelled", "Cancelled.", 130);
	if (options.command === "run") {
		const result = await runner.turn(firstPrompt ?? "");
		exitCode = result.exitCode;
		if (options.stream)
			finalOutput = `${serialize({ type: "result", ...result }, secrets)}\n`;
		else if (options.json) finalOutput = `${serialize(result, secrets)}\n`;
		else if (result.status === "succeeded")
			finalOutput = `${typeof result.result === "string" ? redact(result.result, secrets) : serialize(result.result, secrets, 2)}\n`;
		else process.stderr.write(`${serialize(result.pendingInput, secrets)}\n`);
	} else {
		process.stderr.write(
			"PlinyCode — /exit to finish; end a line with \\ for multiline input.\n",
		);
		let prompt = firstPrompt ?? (await terminal?.prompt());
		while (
			prompt !== undefined &&
			prompt.trim() !== "/exit" &&
			exitCode !== 130
		) {
			if (prompt.trim()) {
				process.stderr.write("\nPlinyCode> ");
				await runner.turn(prompt);
				process.stdout.write("\n");
			}
			prompt = await terminal?.prompt();
		}
	}
}

function reportError(error: unknown) {
	const failure =
		error instanceof CliError
			? error
			: new CliError(
					"execution_failed",
					error instanceof Error ? error.message : String(error),
					1,
				);
	exitCode = failure.exitCode;
	const result = {
		version: 1,
		status:
			failure.exitCode === 130
				? "cancelled"
				: failure.exitCode === 3
					? "needs_input"
					: "failed",
		error: { code: failure.code, message: failure.message },
		exitCode,
	};
	if (args.includes("--json")) finalOutput = `${serialize(result, secrets)}\n`;
	else if (args.includes("--stream"))
		finalOutput = `${serialize({ type: "result", ...result }, secrets)}\n`;
	else process.stderr.write(`${redact(failure.message, secrets)}\n`);
}

try {
	await main();
} catch (error) {
	reportError(error);
} finally {
	terminal?.close();
	removeSignals();
	try {
		await runner?.close();
	} catch (error) {
		if (!exitCode) reportError(error);
		else
			process.stderr.write(
				`Cleanup failed: ${redact(String(error), secrets)}\n`,
			);
	}
}
if (finalOutput) process.stdout.write(finalOutput);
await Promise.all([
	new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
	new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
]);
// Some engine helpers retain idle watchers. This process owns no persistent jobs.
process.exit(exitCode);
