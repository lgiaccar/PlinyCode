/**
 * Assertion checks, run against the case's temp workspace after the agent
 * stops. Each returns a one-line detail that says why it passed or failed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { EvalAssertion } from "./cases";

export interface AssertionResult {
	type: EvalAssertion["type"];
	passed: boolean;
	detail: string;
}

/** What the run produced, as far as the assertions are concerned. */
export interface RunOutcome {
	iterations: number;
	finalText: string;
	toolErrors: Array<{ name: string; error: string }>;
}

const COMMAND_TIMEOUT_MS = 120_000;
const DETAIL_LIMIT = 300;

function clip(text: string, limit = DETAIL_LIMIT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function resolveInside(workspace: string, path: string): string {
	const absolute = resolve(workspace, path);
	const rel = relative(workspace, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path escapes the workspace: ${path}`);
	}
	return absolute;
}

function checkOne(
	assertion: EvalAssertion,
	workspace: string,
	outcome: RunOutcome,
): Omit<AssertionResult, "type"> {
	switch (assertion.type) {
		case "file_exists": {
			const file = resolveInside(workspace, assertion.path);
			const passed = existsSync(file) && statSync(file).isFile();
			return {
				passed,
				detail: passed
					? `${assertion.path} exists`
					: `${assertion.path} does not exist`,
			};
		}
		case "file_contains": {
			const file = resolveInside(workspace, assertion.path);
			if (!existsSync(file)) {
				return { passed: false, detail: `${assertion.path} does not exist` };
			}
			const content = readFileSync(file, "utf8");
			const needle = assertion.text ?? `/${assertion.regex}/`;
			const passed =
				assertion.text !== undefined
					? content.includes(assertion.text)
					: new RegExp(assertion.regex ?? "", "m").test(content);
			return {
				passed,
				detail: passed
					? `${assertion.path} contains ${needle}`
					: `${assertion.path} lacks ${needle}; it starts: "${clip(content, 200)}"`,
			};
		}
		case "command_exit_code": {
			const run = spawnSync(assertion.command, {
				cwd: workspace,
				shell: true,
				encoding: "utf8",
				timeout: COMMAND_TIMEOUT_MS,
				windowsHide: true,
			});
			if (run.error) {
				return {
					passed: false,
					detail: `\`${assertion.command}\` did not run: ${run.error.message}`,
				};
			}
			const code = run.status ?? -1;
			const passed = code === assertion.code;
			const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
			return {
				passed,
				detail: passed
					? `\`${assertion.command}\` exited ${code}`
					: `\`${assertion.command}\` exited ${code}, expected ${assertion.code}; output: ${clip(output.slice(-2000))}`,
			};
		}
		case "no_tool_errors": {
			const passed = outcome.toolErrors.length === 0;
			return {
				passed,
				detail: passed
					? "no tool call failed"
					: `${outcome.toolErrors.length} tool call(s) failed: ${clip(
							outcome.toolErrors
								.map((e) => `${e.name}: ${e.error}`)
								.join(" | "),
						)}`,
			};
		}
		case "iterations_lte": {
			const passed = outcome.iterations <= assertion.n;
			return {
				passed,
				detail: `${outcome.iterations} iteration(s), limit ${assertion.n}`,
			};
		}
		case "final_text_contains": {
			const passed = outcome.finalText.includes(assertion.text);
			return {
				passed,
				detail: passed
					? `final text contains "${assertion.text}"`
					: `final text lacks "${assertion.text}"; it was: "${clip(outcome.finalText)}"`,
			};
		}
	}
}

export function checkAssertions(
	assertions: EvalAssertion[],
	workspace: string,
	outcome: RunOutcome,
): AssertionResult[] {
	return assertions.map((assertion) => {
		try {
			return {
				type: assertion.type,
				...checkOne(assertion, workspace, outcome),
			};
		} catch (error) {
			return {
				type: assertion.type,
				passed: false,
				detail: `check failed: ${(error as Error).message}`,
			};
		}
	});
}
