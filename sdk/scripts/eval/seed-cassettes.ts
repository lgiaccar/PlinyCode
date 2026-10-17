#!/usr/bin/env bun
/**
 * Writes the hand-scripted cassettes of the seed cases.
 *
 *   bun sdk/scripts/eval/seed-cassettes.ts
 *
 * The seed cases were written without access to the Pliny gateway, so their
 * model turns are scripted here and rendered into the SSE format the gateway
 * streams (see lib/cassette.ts). A case recorded with `run.ts --record` gets
 * a real cassette instead and should be removed from this list.
 *
 * Paths in tool calls are relative: the engine resolves them against the
 * session's cwd, which is a different temp directory on every run.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLINY_BASE_URL } from "@plinycode/llms";
import { buildCassette, type ScriptedTurn } from "./lib/cassette";

const PLAN = `# Add farewell(name)

## Goal
Add a \`farewell(name)\` function next to \`greet()\` in \`src/greet.ts\`.

## Steps
1. In \`src/greet.ts\`, export \`farewell(name: string): string\` returning \`Goodbye, \${name}!\`.
2. Mention \`farewell\` in README.md.

## Verify
- \`farewell("Ada")\` returns \`Goodbye, Ada!\`.
`;

const SEEDS: Record<string, { model: string; turns: ScriptedTurn[] }> = {
	"create-file": {
		model: "GLM-5.2",
		turns: [
			{
				reasoning: "The user wants a one-line file. The editor creates it.",
				toolCalls: [
					{
						name: "editor",
						input: { path: "hello.txt", new_text: "Hello from PlinyCode\n" },
					},
				],
				usage: { input: 4200, output: 60 },
			},
			{
				text: "Created hello.txt containing the line `Hello from PlinyCode`.",
				usage: { input: 4300, output: 20 },
			},
		],
	},
	"fix-failing-test": {
		model: "aws-claude-sonnet-4.6",
		turns: [
			{
				text: "Let me look at math.ts first.",
				toolCalls: [
					{ name: "read_files", input: { files: [{ path: "math.ts" }] } },
				],
				usage: { input: 4100, output: 40 },
			},
			{
				text: "The loop starts at index 1, so the first value is skipped.",
				toolCalls: [
					{
						name: "editor",
						input: {
							path: "math.ts",
							old_text: "for (let i = 1; i < values.length; i++) {",
							new_text: "for (let i = 0; i < values.length; i++) {",
						},
					},
				],
				usage: { input: 4400, output: 90 },
			},
			{
				toolCalls: [
					{ name: "run_commands", input: { commands: ["bun test"] } },
				],
				usage: { input: 4700, output: 30 },
			},
			{
				text: "Fixed the off-by-one in `sum` (the loop now starts at 0); `bun test` passes.",
				usage: { input: 5000, output: 30 },
			},
		],
	},
	"answer-question": {
		model: "GLM-5.2",
		turns: [
			{
				toolCalls: [
					{ name: "read_files", input: { files: [{ path: "src/greet.ts" }] } },
				],
				usage: { input: 3900, output: 30 },
			},
			{
				text: 'greet("Ada") returns the string "Hello, Ada!": it fills the name into a "Hello, <name>!" template.',
				usage: { input: 4000, output: 30 },
			},
		],
	},
	"plan-markdown": {
		model: "GLM-5.2",
		turns: [
			{
				toolCalls: [
					{ name: "read_files", input: { files: [{ path: "src/greet.ts" }] } },
				],
				usage: { input: 4500, output: 30 },
			},
			{
				toolCalls: [
					{
						name: "editor",
						input: { path: "plans/add-farewell/PLAN.md", new_text: PLAN },
					},
				],
				usage: { input: 4600, output: 160 },
			},
			{
				text: "The plan is in plans/add-farewell/PLAN.md: add farewell(name) to src/greet.ts and mention it in the README.",
				usage: { input: 4800, output: 40 },
			},
		],
	},
};

for (const [id, seed] of Object.entries(SEEDS)) {
	const cassette = buildCassette({
		baseUrl: PLINY_BASE_URL,
		model: seed.model,
		turns: seed.turns,
	});
	const file = join(import.meta.dir, "cases", id, "cassette.json");
	writeFileSync(file, `${JSON.stringify(cassette, null, "\t")}\n`);
	console.log(`wrote ${file} (${cassette.length} responses)`);
}
