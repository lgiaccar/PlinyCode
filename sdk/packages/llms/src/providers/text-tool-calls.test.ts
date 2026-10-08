import { describe, expect, it } from "vitest";
import { parseLeakedToolCalls } from "./kimi-tool-calls";
import {
	createTextToolCallFilter,
	parseTextToolCalls,
	type TextToolCallTool,
} from "./text-tool-calls";

const TOOLS = [
	"skills",
	"read_files",
	"search_codebase",
	"editor",
	"plinycode-devops__pr_create",
	"run_commands",
	"wait",
];

const TOOL_DEFINITIONS: TextToolCallTool[] = [
	{
		name: "read_files",
		inputSchema: { type: "object", properties: { files: { type: "array" } } },
	},
	{
		name: "skills",
		inputSchema: { type: "object", properties: { skill: { type: "string" } } },
	},
	{
		name: "run_commands",
		inputSchema: {
			type: "object",
			properties: { commands: { type: "array" }, timeout: { type: "number" } },
		},
	},
	...["search_codebase", "editor", "plinycode-devops__pr_create", "wait"].map(
		(name) => ({ name }),
	),
];

/** Claude's XML namespace prefix, built so the fixtures can show both spellings. */
const NS = ["antml", ":"].join("");

function run(
	deltas: string[],
	options: { recover?: boolean; hadToolCalls?: boolean } = {},
) {
	const filter = createTextToolCallFilter(TOOL_DEFINITIONS);
	const shown = deltas.map((delta) => filter.push(delta)).join("");
	const end = filter.finish({ recover: true, ...options });
	return { shown, ...end };
}

function chunks(text: string, size: number): string[] {
	const parts: string[] = [];
	for (let start = 0; start < text.length; start += size) {
		parts.push(text.slice(start, start + size));
	}
	return parts;
}

const LEAKED_SECTION =
	'<|tool_calls_section_begin|> <|tool_call_begin|> functions.run_commands:17 <|tool_call_argument_begin|> {"commands": ["git status"]} <|tool_call_end|> <|tool_calls_section_end|>';

describe("createTextToolCallFilter: Kimi tokens", () => {
	it("passes ordinary text through untouched, angle brackets included", () => {
		const text = "Use `a < b` or <|x|> and List<|T|>; nothing to hold. <";
		const { shown, text: rest, calls } = run(text.split(/(?<=\s)/));
		expect(shown + rest).toBe(text);
		expect(calls).toEqual([]);
	});

	it("turns a leaked section into its tool call, however the stream cut it", () => {
		const reply = `Let me verify by running it:  ${LEAKED_SECTION}`;
		for (const size of [1, 7, 1000]) {
			const deltas = reply.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];
			const { shown, text, calls } = run(deltas);
			expect(shown).toBe("Let me verify by running it:  ");
			expect(text).toBe("");
			expect(calls).toEqual([
				{ toolName: "run_commands", input: { commands: ["git status"] } },
			]);
		}
	});

	it("reads several calls, and the mangled ids Kimi writes", () => {
		const section =
			'<|tool_calls_section_begin|> <|tool_call_begin|> functions-run-commands-0-ca476m3kqt6mhr {"commands": ["ls"]} <|tool_call_end|>' +
			' <|tool_call_begin|> functions.read_files:1 <|tool_call_argument_begin|> {"files": [{"path": "a.ts"}]} <|tool_call_end|> <|tool_calls_section_end|>';
		expect(parseLeakedToolCalls(section, TOOLS)).toEqual([
			{ toolName: "run_commands", input: { commands: ["ls"] } },
			{ toolName: "read_files", input: { files: [{ path: "a.ts" }] } },
		]);
	});

	it("shows the section as text when no call can be read from it", () => {
		const garbage =
			"Let me clean up: <|tool_calls_section_begin|> <|tool_call_begin|> chatcmpl-tool-92d46e95896a0361Remove-Item fix_conflicts.py\ngit status";
		const { shown, text, calls } = run([garbage]);
		expect(shown + text).toBe(garbage);
		expect(calls).toEqual([]);
		// A call without arguments is not run on a guess.
		expect(
			parseLeakedToolCalls(
				"<|tool_call_begin|> functions.wait:2 <|tool_call_end|>",
				TOOLS,
			),
		).toEqual([]);
	});

	it("does not run calls from a reply that failed or was cut short", () => {
		const { shown, text, calls } = run(["Running: ", LEAKED_SECTION], {
			recover: false,
		});
		expect(shown + text).toBe(`Running: ${LEAKED_SECTION}`);
		expect(calls).toEqual([]);
	});
});

/** Kimi K2.6's first FreeAuto reply on 2026-10-06, as persisted: reasoning, then two calls written as text. */
const KIMI_INVOKE_REPLY =
	"I'll start by reading the pipeline failures investigation prompt and invoking the `analyze-pipeline-deltas` skill.\n\n" +
	'<invoke name="read_files">\n<parameter name="files">[\n  {\n    "path": "d:\\\\dev1\\\\GPUSurfer\\\\AI_prompts\\\\pipelines_failures_investigation.md"\n  }\n]\n</parameter>\n</invoke>\n' +
	'<invoke name="skills">\n<parameter name="skill">analyze-pipeline-deltas</parameter>\n</invoke>';

/** A BalanceAuto reply from 2026-09-26: Qwen3-Coder's own XML tool-call format. */
const QWEN_REPLY =
	"Actually, let me just read the end of the HEAD file:\n\n\n<tool_call>\n<function=read_files>\n<parameter=files>\n" +
	'[{"path": "d:\\\\dev0\\\\GPUSurfer\\\\ai_output\\\\TestClosestFaceBVH_HEAD.cxx", "start_line": 1250, "end_line": 1261}]\n' +
	"</parameter>\n</function>\n</tool_call>\n";

describe("createTextToolCallFilter: calls written as text", () => {
	it("turns Anthropic-style invoke blocks into tool calls, however the stream cut them", () => {
		for (const size of [1, 5, 13, 1000]) {
			const { shown, text, calls } = run(chunks(KIMI_INVOKE_REPLY, size));
			expect(shown).toBe(
				"I'll start by reading the pipeline failures investigation prompt and invoking the `analyze-pipeline-deltas` skill.\n\n",
			);
			expect(text).toBe("");
			expect(calls).toEqual([
				{
					toolName: "read_files",
					input: {
						files: [
							{
								path: "d:\\dev1\\GPUSurfer\\AI_prompts\\pipelines_failures_investigation.md",
							},
						],
					},
				},
				{ toolName: "skills", input: { skill: "analyze-pipeline-deltas" } },
			]);
		}
	});

	it("reads the namespaced form inside a function_calls block", () => {
		const reply =
			`Checking.\n<${NS}function_calls>\n<${NS}invoke name="run_commands">\n` +
			`<${NS}parameter name="commands">["git status"]</${NS}parameter>\n` +
			`<${NS}parameter name="timeout">30</${NS}parameter>\n` +
			`</${NS}invoke>\n</${NS}function_calls>`;
		const { shown, calls } = run(chunks(reply, 3));
		expect(shown).toBe("Checking.\n");
		expect(calls).toEqual([
			{
				toolName: "run_commands",
				input: { commands: ["git status"], timeout: 30 },
			},
		]);
	});

	it("turns Qwen3-Coder's XML into a tool call", () => {
		const { shown, calls } = run(chunks(QWEN_REPLY, 7));
		expect(shown).toBe(
			"Actually, let me just read the end of the HEAD file:\n\n\n",
		);
		expect(calls).toEqual([
			{
				toolName: "read_files",
				input: {
					files: [
						{
							path: "d:\\dev0\\GPUSurfer\\ai_output\\TestClosestFaceBVH_HEAD.cxx",
							start_line: 1250,
							end_line: 1261,
						},
					],
				},
			},
		]);
	});

	it("turns a Hermes JSON tool call into a tool call, with a misnamed tool resolved", () => {
		const reply =
			'<tool_call>\n{"name": "functions.run_commands", "arguments": {"commands": ["ls"]}}\n</tool_call>';
		expect(run([reply]).calls).toEqual([
			{ toolName: "run_commands", input: { commands: ["ls"] } },
		]);
	});

	it("reads Windows paths written with single backslashes", () => {
		expect(
			parseTextToolCalls(
				'<invoke name="read_files"><parameter name="files">[{"path": "d:\dev1\a.md"}]</parameter></invoke>',
				TOOL_DEFINITIONS,
			),
		).toEqual([
			{ toolName: "read_files", input: { files: [{ path: "d:\dev1\a.md" }] } },
		]);
	});

	it("keeps a string parameter as written, even when it looks like JSON", () => {
		expect(
			parseTextToolCalls(
				'<invoke name="skills"><parameter name="skill">123</parameter></invoke>',
				TOOL_DEFINITIONS,
			),
		).toEqual([{ toolName: "skills", input: { skill: "123" } }]);
	});

	it("leaves the text alone when prose follows the markup", () => {
		const reply =
			'Here is how a call looks: <invoke name="wait"><parameter name="seconds">5</parameter></invoke> and that is all.';
		const { shown, text, calls } = run(chunks(reply, 4));
		expect(shown + text).toBe(reply);
		expect(calls).toEqual([]);
	});

	it("leaves markup inside a code fence alone, and shows it as it streams", () => {
		const reply =
			'The format is:\n```xml\n<invoke name="read_files">\n<parameter name="files">[]</parameter>\n</invoke>\n```\n';
		const filter = createTextToolCallFilter(TOOL_DEFINITIONS);
		const shown = chunks(reply, 6)
			.map((delta) => filter.push(delta))
			.join("");
		const end = filter.finish({ recover: true });
		expect(shown + end.text).toBe(reply);
		expect(shown.length).toBeGreaterThan(reply.length - 12);
		expect(end.calls).toEqual([]);
	});

	it("runs nothing when one call names a tool that does not exist", () => {
		const reply =
			'<invoke name="skills"><parameter name="skill">a</parameter></invoke><invoke name="delete_everything"></invoke>';
		const { text, calls } = run([reply]);
		expect(text).toBe(reply);
		expect(calls).toEqual([]);
	});

	it("runs nothing when an argument cannot be read", () => {
		const reply =
			'<invoke name="read_files"><parameter name="files">[{"path": </parameter></invoke>';
		expect(run([reply]).calls).toEqual([]);
	});

	it("leaves text-written calls alone when the reply also made real tool calls", () => {
		const { text, calls } = run([KIMI_INVOKE_REPLY], { hadToolCalls: true });
		expect(text.startsWith('<invoke name="read_files">')).toBe(true);
		expect(calls).toEqual([]);
	});

	it("does not run calls from a reply that failed or was cut short", () => {
		const { shown, text, calls } = run([KIMI_INVOKE_REPLY], { recover: false });
		expect(shown + text).toBe(KIMI_INVOKE_REPLY);
		expect(calls).toEqual([]);
	});
});
