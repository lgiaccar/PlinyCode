import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/options";
import { redact, StreamRedactor, serialize } from "../src/output";
import { toolPolicies } from "../src/runner";

describe("CLI contract", () => {
	test("pipeline execution denies actions unless explicitly allowed", () => {
		const options = parseOptions([
			"run",
			"--model",
			"example",
			"--file",
			"a.log",
			"--file",
			"b.log",
			"--json",
		]);
		expect(options.files).toHaveLength(2);
		expect(options.allowTools).toBe(false);
		expect(toolPolicies(false)["*"].autoApprove).toBe(false);
		expect(toolPolicies(false).read_files.autoApprove).toBe(true);
		expect(toolPolicies(true)["*"].autoApprove).toBe(true);
	});
	test("rejects YAML jobs, ambiguous output, and invalid limits", () => {
		for (const args of [
			["run", "job.yaml"],
			["run", "--json", "--stream"],
			["run", "--timeout", "NaN"],
			["run", "--max-iterations", "0"],
			["chat", "--json"],
		])
			expect(() => parseOptions(args)).toThrow();
	});
	test("redacts known credentials and bearer tokens", () => {
		expect(redact("secret Bearer abc.def", ["secret"])).toBe(
			"[REDACTED] Bearer [REDACTED]",
		);
	});
	test("redaction preserves JSON types and spans streaming chunk boundaries", () => {
		expect(JSON.parse(serialize({ version: 1, message: "1" }, ["1"]))).toEqual({
			version: 1,
			message: "[REDACTED]",
		});
		const redactor = new StreamRedactor(["test-cli-secret"]);
		const text =
			redactor.push("Prefix test-cl") +
			redactor.push("i-secret suffix") +
			redactor.flush();
		expect(text).toBe("Prefix [REDACTED] suffix");
	});
});
