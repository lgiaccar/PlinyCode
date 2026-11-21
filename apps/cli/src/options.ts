import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PLINY_FREE_AUTO_MODEL_ID } from "@plinycode/llms";

export class CliError extends Error {
	constructor(
		public code: string,
		message: string,
		public exitCode = 2,
	) {
		super(message);
	}
}

export interface Options {
	command: "run" | "chat" | "models" | "doctor" | "auth";
	authAction?: string;
	model?: string;
	prompt?: string;
	files: string[];
	stdin: boolean;
	json: boolean;
	stream: boolean;
	allowTools: boolean;
	cwd: string;
	schema?: string;
	mcpConfig?: string;
	exportPath?: string;
	artifactsDir?: string;
	behavior: "balanced" | "decisive" | "curious";
	timeout: number;
	maxIterations: number;
	help: boolean;
}

export function parseOptions(args: string[]): Options {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args,
			allowPositionals: true,
			strict: true,
			options: {
				model: { type: "string" },
				prompt: { type: "string" },
				file: { type: "string", multiple: true },
				stdin: { type: "boolean" },
				json: { type: "boolean" },
				stream: { type: "boolean" },
				"allow-tools": { type: "boolean" },
				cwd: { type: "string" },
				"output-schema": { type: "string" },
				"mcp-config": { type: "string" },
				export: { type: "string" },
				"artifacts-dir": { type: "string" },
				behavior: { type: "string" },
				timeout: { type: "string" },
				"max-iterations": { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (error) {
		throw new CliError("invalid_arguments", String(error));
	}
	const v = parsed.values;
	const command = parsed.positionals[0] ?? "chat";
	if (!["run", "chat", "models", "doctor", "auth"].includes(command)) {
		throw new CliError(
			"invalid_arguments",
			`Unknown command: ${command}. Use --help.`,
		);
	}
	if (parsed.positionals.length > (command === "auth" ? 2 : 1)) {
		throw new CliError(
			"invalid_arguments",
			"Use --prompt, --file or --stdin. PlinyCode does not read YAML job files.",
		);
	}
	const str = (key: string) =>
		typeof v[key] === "string" ? (v[key] as string) : undefined;
	const positive = (key: string, fallback: number, max: number) => {
		const value = Number(str(key) ?? fallback);
		if (!Number.isSafeInteger(value) || value < 1 || value > max)
			throw new CliError(
				"invalid_arguments",
				`--${key} must be an integer between 1 and ${max}.`,
			);
		return value;
	};
	const behavior = str("behavior") ?? "balanced";
	if (!["balanced", "decisive", "curious"].includes(behavior))
		throw new CliError("invalid_arguments", "Unknown --behavior.");
	if (v.json && v.stream)
		throw new CliError(
			"invalid_arguments",
			"Choose --json or --stream, not both.",
		);
	if (
		command === "chat" &&
		(v.json || v.stream || v.stdin || v["output-schema"])
	)
		throw new CliError(
			"invalid_arguments",
			"--json, --stream, --stdin and --output-schema are run options.",
		);
	const cwd = resolve(str("cwd") ?? process.cwd());
	const path = (key: string) => {
		const value = str(key);
		return value ? resolve(cwd, value) : undefined;
	};
	return {
		command: command as Options["command"],
		authAction: parsed.positionals[1],
		model: str("model") ?? PLINY_FREE_AUTO_MODEL_ID,
		prompt: str("prompt"),
		files: ((v.file ?? []) as string[]).map((p) => resolve(cwd, p)),
		stdin: v.stdin === true,
		json: v.json === true,
		stream: v.stream === true,
		allowTools: v["allow-tools"] === true,
		cwd,
		schema: path("output-schema"),
		mcpConfig: path("mcp-config"),
		exportPath: path("export"),
		artifactsDir: path("artifacts-dir"),
		behavior: behavior as Options["behavior"],
		timeout: positive("timeout", 900, 86400),
		maxIterations: positive("max-iterations", 40, 1000),
		help: v.help === true,
	};
}

export const HELP = `PlinyCode CLI

  plinycode chat [--model <id>] [--export transcript.md]
  plinycode run [--model <id>] --prompt <text> [--file <path> ...] [--stdin]
  plinycode models [--json]
  plinycode doctor [--json]
  plinycode auth login [--stdin] | logout

Run options:
  --json                  One result envelope on stdout; diagnostics on stderr
  --stream                Newline-delimited progress events and final result
  --output-schema <file>   Validate the final payload against JSON Schema
  --artifacts-dir <dir>    Report files generated in this directory
  --allow-tools           Approve enabled tools for this trusted-user run
  --mcp-config <file>      Explicit MCP server JSON configuration
  --cwd <directory>       Workspace (all relative file paths resolve here)
  --behavior <profile>    balanced (default), decisive, or curious
  --timeout <seconds>     Turn timeout, including model and tool calls (default 900)
  --max-iterations <n>    Agent iteration limit (default 40)

Omitting --model selects FreeAuto (pliny/auto-free), which uses free models only.
Use --model <id> for a concrete Pliny model. Other router profiles are not supported.
PLINY_API_KEY overrides securely stored credentials. No YAML job parser or server.
Chat: /exit ends the session; end a line with \\ to continue on another line.
Exit codes: 0 success, 1 execution failure, 2 invalid input, 3 needs input,
4 invalid model output, 124 timeout, 130 cancellation.
`;
