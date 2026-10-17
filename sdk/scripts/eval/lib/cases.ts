/**
 * Eval case format: `cases/<id>/case.yaml`, validated here.
 * The format is documented in ../README.md.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type EvalMode = "act" | "plan" | "ask";

export type EvalAssertion =
	| { type: "file_contains"; path: string; text?: string; regex?: string }
	| { type: "file_exists"; path: string }
	| { type: "command_exit_code"; command: string; code: number }
	| { type: "no_tool_errors" }
	| { type: "iterations_lte"; n: number }
	| { type: "final_text_contains"; text: string };

export interface EvalCase {
	id: string;
	tags: string[];
	/** Directory under `fixtures/`, copied to a fresh temp dir for each run. */
	fixture: string;
	prompt: string;
	mode: EvalMode;
	/** A Pliny model id, e.g. `snps-provider/GLM-5.2`. */
	model: string;
	maxIterations: number;
	/** Wall-clock budget for the agent run (default 120 offline, 900 recording). */
	timeoutSeconds?: number;
	assertions: EvalAssertion[];
	/** Absolute path of the case directory. */
	dir: string;
	/** Absolute path of the case's cassette (may not exist yet). */
	cassettePath: string;
}

const CASE_KEYS = new Set([
	"id",
	"tags",
	"fixture",
	"prompt",
	"mode",
	"model",
	"maxIterations",
	"timeoutSeconds",
	"assertions",
]);

const ASSERTION_FIELDS: Record<EvalAssertion["type"], string[]> = {
	file_contains: ["path", "text", "regex"],
	file_exists: ["path"],
	command_exit_code: ["command", "code"],
	no_tool_errors: [],
	iterations_lte: ["n"],
	final_text_contains: ["text"],
};

class CaseError extends Error {}

function fail(file: string, message: string): never {
	throw new CaseError(`${file}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	file: string,
	record: Record<string, unknown>,
	key: string,
	where = "",
): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim() === "") {
		fail(file, `${where}\`${key}\` must be a non-empty string`);
	}
	return value;
}

function requireInteger(
	file: string,
	record: Record<string, unknown>,
	key: string,
	where = "",
): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		fail(file, `${where}\`${key}\` must be an integer`);
	}
	return value;
}

function parseAssertion(
	file: string,
	raw: unknown,
	index: number,
): EvalAssertion {
	const where = `assertions[${index}]: `;
	if (!isRecord(raw)) {
		fail(file, `${where}must be a mapping with a \`type\``);
	}
	const type = raw.type;
	if (typeof type !== "string" || !(type in ASSERTION_FIELDS)) {
		fail(
			file,
			`${where}unknown type ${JSON.stringify(type)}; expected one of ${Object.keys(ASSERTION_FIELDS).join(", ")}`,
		);
	}
	const allowed = new Set([
		"type",
		...ASSERTION_FIELDS[type as EvalAssertion["type"]],
	]);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			fail(file, `${where}unexpected field \`${key}\` for ${type}`);
		}
	}
	switch (type as EvalAssertion["type"]) {
		case "file_contains": {
			const path = requireString(file, raw, "path", where);
			const text = raw.text;
			const regex = raw.regex;
			if ((text === undefined) === (regex === undefined)) {
				fail(
					file,
					`${where}file_contains needs exactly one of \`text\` or \`regex\``,
				);
			}
			if (text !== undefined) {
				return {
					type: "file_contains",
					path,
					text: requireString(file, raw, "text", where),
				};
			}
			const pattern = requireString(file, raw, "regex", where);
			try {
				new RegExp(pattern);
			} catch (error) {
				fail(file, `${where}invalid regex: ${(error as Error).message}`);
			}
			return { type: "file_contains", path, regex: pattern };
		}
		case "file_exists":
			return {
				type: "file_exists",
				path: requireString(file, raw, "path", where),
			};
		case "command_exit_code":
			return {
				type: "command_exit_code",
				command: requireString(file, raw, "command", where),
				code: requireInteger(file, raw, "code", where),
			};
		case "no_tool_errors":
			return { type: "no_tool_errors" };
		case "iterations_lte":
			return {
				type: "iterations_lte",
				n: requireInteger(file, raw, "n", where),
			};
		case "final_text_contains":
			return {
				type: "final_text_contains",
				text: requireString(file, raw, "text", where),
			};
	}
}

/** Parse and validate one case file. Throws with the file name and the problem. */
export function loadCase(caseDir: string, fixturesDir: string): EvalCase {
	const file = join(caseDir, "case.yaml");
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(readFileSync(file, "utf8"));
	} catch (error) {
		fail(file, `not valid YAML: ${(error as Error).message}`);
	}
	if (!isRecord(raw)) {
		fail(file, "must be a YAML mapping");
	}
	for (const key of Object.keys(raw)) {
		if (!CASE_KEYS.has(key)) {
			fail(file, `unexpected field \`${key}\``);
		}
	}
	const id = requireString(file, raw, "id");
	const dirName = caseDir.split(/[\\/]/).pop();
	if (id !== dirName) {
		fail(
			file,
			`\`id\` (${id}) must match the case directory name (${dirName})`,
		);
	}
	const tags = raw.tags ?? [];
	if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
		fail(file, "`tags` must be a list of strings");
	}
	const fixture = requireString(file, raw, "fixture");
	const fixtureDir = join(fixturesDir, fixture);
	if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
		fail(file, `fixture directory not found: ${fixtureDir}`);
	}
	const mode = raw.mode ?? "act";
	if (mode !== "act" && mode !== "plan" && mode !== "ask") {
		fail(file, "`mode` must be act, plan or ask");
	}
	const maxIterations = requireInteger(file, raw, "maxIterations");
	if (maxIterations < 1) {
		fail(file, "`maxIterations` must be at least 1");
	}
	let timeoutSeconds: number | undefined;
	if (raw.timeoutSeconds !== undefined) {
		timeoutSeconds = requireInteger(file, raw, "timeoutSeconds");
	}
	if (!Array.isArray(raw.assertions) || raw.assertions.length === 0) {
		fail(file, "`assertions` must be a non-empty list");
	}
	return {
		id,
		tags: tags as string[],
		fixture,
		prompt: requireString(file, raw, "prompt"),
		mode,
		model: requireString(file, raw, "model"),
		maxIterations,
		timeoutSeconds,
		assertions: raw.assertions.map((assertion, index) =>
			parseAssertion(file, assertion, index),
		),
		dir: caseDir,
		cassettePath: join(caseDir, "cassette.json"),
	};
}

/** Every case under `casesDir`, sorted by id. */
export function loadCases(casesDir: string, fixturesDir: string): EvalCase[] {
	return readdirSync(casesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => loadCase(join(casesDir, name), fixturesDir));
}
