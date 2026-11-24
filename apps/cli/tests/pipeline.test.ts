import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { isPlinySelfHostedModelId } from "@plinycode/llms";

const scratchRoot = resolve(import.meta.dir, "../../../ai_output");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "cli-test-"));
const schemaPath = join(scratch, "schema.json");
await writeFile(
	schemaPath,
	JSON.stringify({
		type: "object",
		required: ["judgement"],
		properties: { judgement: { enum: ["fail", "pass"] } },
		additionalProperties: false,
	}),
);
afterAll(() => rm(scratch, { recursive: true, force: true, maxRetries: 5 }));
const entry =
	process.env.PLINYCODE_TEST_ENTRY ??
	resolve(import.meta.dir, "../src/main.ts");
const runtime = process.env.PLINYCODE_TEST_RUNTIME ?? process.execPath;
const model = "snps-provider-vmodels/glm-5.3";

async function extensionWorkspace() {
	const workspace = await mkdtemp(join(scratch, "extensions-"));
	const skills = join(workspace, ".github", "skills", "review");
	const agents = join(workspace, ".github", "agents");
	await mkdir(skills, { recursive: true });
	await mkdir(agents, { recursive: true });
	await writeFile(
		join(skills, "SKILL.md"),
		"---\nname: review\ndescription: Review test evidence\n---\nSKILL_EVIDENCE_MARKER. Cite exact failures.",
	);
	await writeFile(
		join(agents, "reviewer.md"),
		"---\nname: reviewer\ndescription: Review test evidence\ntools: [read_files, skills]\nskills: [review]\n---\nCUSTOM_REVIEWER_MARKER. Review without editing.",
	);
	return workspace;
}

test("skills are advertised and loaded through the engine tool without action permission", async () => {
	const cwd = await extensionWorkspace();
	const requests: string[] = [];
	const result = await run(
		["--cwd", cwd, "--prompt", "Use review", "--json"],
		[{ name: "skills", input: { skill: "review" } }, "Reviewed"],
		undefined,
		(body) => {
			requests.push(JSON.stringify(body));
		},
	);
	expect(result.exit).toBe(0);
	expect(requests[0]).toContain("Review test evidence");
	expect(requests[1]).toContain("SKILL_EVIDENCE_MARKER");
}, 30000);

test("custom delegation runs scoped tools and a skill and returns to the lead", async () => {
	const cwd = await extensionWorkspace();
	const requests: Array<Record<string, unknown>> = [];
	const result = await run(
		["--cwd", cwd, "--prompt", "Delegate review", "--allow-tools", "--json"],
		[
			{ name: "subagent_reviewer", input: { prompt: "Review evidence" } },
			{ name: "skills", input: { skill: "review" } },
			"CHILD_FINDING",
			"PARENT_SUMMARY",
		],
		undefined,
		(body) => {
			requests.push(body);
		},
	);
	expect(result.stderr).not.toContain("execution_failed");
	expect(result.exit).toBe(0);
	expect(JSON.parse(result.stdout).result).toBe("PARENT_SUMMARY");
	expect(JSON.stringify(requests[1])).toContain("CUSTOM_REVIEWER_MARKER");
	expect(JSON.stringify(requests[2])).toContain("SKILL_EVIDENCE_MARKER");
	expect(JSON.stringify(requests[3])).toContain("CHILD_FINDING");
	expect(JSON.stringify(requests[1].tools)).not.toContain('"name":"editor"');
}, 30000);

test("unattended custom delegation requires explicit permission", async () => {
	const cwd = await extensionWorkspace();
	const result = await run(
		["--cwd", cwd, "--prompt", "Delegate", "--json"],
		[
			{ name: "subagent_reviewer", input: { prompt: "Review" } },
			"Must not run",
		],
	);
	expect(result.exit).toBe(3);
	expect(result.calls).toBe(1);
}, 30000);

test("generic delegation inherits FreeAuto, skills and the depth limit", async () => {
	const cwd = await extensionWorkspace();
	const requests: Array<Record<string, unknown>> = [];
	const result = await run(
		[
			"--cwd",
			cwd,
			"--model",
			"pliny/auto-free",
			"--prompt",
			"Delegate",
			"--allow-tools",
			"--json",
		],
		[
			{ name: "spawn_agent", input: { task: "Review" } },
			{ name: "skills", input: { skill: "review" } },
			"GENERIC_CHILD",
			"GENERIC_PARENT",
		],
		undefined,
		(body) => {
			requests.push(body);
		},
	);
	expect(result.exit).toBe(0);
	expect(JSON.parse(result.stdout).result).toBe("GENERIC_PARENT");
	expect(requests).toHaveLength(4);
	for (const request of requests)
		expect(isPlinySelfHostedModelId(String(request.model))).toBe(true);
	expect(JSON.stringify(requests[1].tools)).not.toContain(
		'"name":"spawn_agent"',
	);
	expect(JSON.stringify(requests[2])).toContain("SKILL_EVIDENCE_MARKER");
}, 30000);

test("custom lead agent uses instructions and rejects unknown names before inference", async () => {
	const cwd = await extensionWorkspace();
	let request = "";
	const result = await run(
		["--cwd", cwd, "--agent", "reviewer", "--prompt", "Review", "--json"],
		["Reviewed"],
		undefined,
		(body) => {
			request = JSON.stringify(body);
		},
	);
	expect(result.exit).toBe(0);
	expect(request).toContain("CUSTOM_REVIEWER_MARKER");
	const bad = await run(
		["--cwd", cwd, "--agent", "missing", "--prompt", "Review", "--json"],
		["Never"],
	);
	expect(bad.exit).toBe(2);
	expect(bad.calls).toBe(0);
}, 30000);

test("timeout cancels a delegated run", async () => {
	const result = await run(
		["--prompt", "Delegate", "--allow-tools", "--timeout", "5", "--json"],
		[{ name: "spawn_agent", input: { task: "Slow work" } }, { hang: true }],
	);
	expect(result.exit).toBe(124);
	expect(result.calls).toBe(2);
}, 30000);

test("a configured child's explicit free model overrides the parent router", async () => {
	const cwd = await extensionWorkspace();
	await writeFile(
		join(cwd, ".github", "agents", "reviewer.md"),
		`---\nname: reviewer\nmodelId: ${model}\ntools: []\n---\nReview evidence.`,
	);
	const requests: Array<Record<string, unknown>> = [];
	const result = await run(
		[
			"--cwd",
			cwd,
			"--model",
			"pliny/auto-free",
			"--prompt",
			"Delegate",
			"--allow-tools",
			"--json",
		],
		[
			{ name: "subagent_reviewer", input: { prompt: "Review" } },
			"CHILD",
			"PARENT",
		],
		undefined,
		(body) => {
			requests.push(body);
		},
	);
	expect(result.exit).toBe(0);
	expect(requests[1].model).toBe(model);
	expect(requests[1].tools ?? []).toHaveLength(0);
}, 30000);

test("configured agent skill allowlists cannot be widened by inherited extensions", async () => {
	const cwd = await extensionWorkspace();
	const other = join(cwd, ".github", "skills", "other");
	await mkdir(other, { recursive: true });
	await writeFile(
		join(other, "SKILL.md"),
		"---\nname: other\ndescription: Other task\n---\nFORBIDDEN_SKILL_BODY",
	);
	const requests: string[] = [];
	const result = await run(
		["--cwd", cwd, "--prompt", "Delegate", "--allow-tools", "--json"],
		[
			{ name: "subagent_reviewer", input: { prompt: "Review" } },
			{ name: "skills", input: { skill: "other" } },
			"CHILD",
			"PARENT",
		],
		undefined,
		(body) => {
			requests.push(JSON.stringify(body));
		},
	);
	expect(result.exit).toBe(0);
	expect(requests[2]).not.toContain("FORBIDDEN_SKILL_BODY");
}, 30000);

test("discovered agents cannot change provider or escape FreeAuto's free pool", async () => {
	for (const frontmatter of [
		"providerId: anthropic",
		"modelId: does-not-exist",
	]) {
		const cwd = await extensionWorkspace();
		await writeFile(
			join(cwd, ".github", "agents", "bad.md"),
			`---\nname: bad\n${frontmatter}\n---\nWrong model.`,
		);
		const result = await run(
			[
				"--cwd",
				cwd,
				"--model",
				"pliny/auto-free",
				"--prompt",
				"Review",
				"--json",
			],
			["Never"],
		);
		expect(result.exit).toBe(2);
		expect(result.calls).toBe(0);
	}
}, 30000);
type Turn = string | { name: string; input: unknown } | { hang: true };

function gateway(
	turns: Turn[],
	inspect?: (body: Record<string, unknown>) => void,
) {
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Record<string, unknown>;
			inspect?.(body);
			const turn = turns[Math.min(calls++, turns.length - 1)];
			if (typeof turn !== "string" && "hang" in turn)
				return new Response(new ReadableStream(), {
					headers: { "content-type": "text/event-stream" },
				});
			const delta =
				typeof turn === "string"
					? { content: turn }
					: {
							tool_calls: [
								{
									index: 0,
									id: `call_${calls}`,
									type: "function",
									function: {
										name: turn.name,
										arguments: JSON.stringify(turn.input),
									},
								},
							],
						};
			const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
			return new Response(
				chunk({
					id: "test",
					object: "chat.completion.chunk",
					model,
					choices: [{ index: 0, delta, finish_reason: null }],
				}) +
					chunk({
						id: "test",
						object: "chat.completion.chunk",
						model,
						choices: [
							{
								index: 0,
								delta: {},
								finish_reason: typeof turn === "string" ? "stop" : "tool_calls",
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					}) +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return { server, calls: () => calls };
}

async function run(
	args: string[],
	turns: Turn[],
	input?: string,
	inspect?: (body: Record<string, unknown>) => void,
) {
	const mock = gateway(turns, inspect);
	try {
		const child = Bun.spawn(
			[
				runtime,
				entry,
				"run",
				"--model",
				model,
				"--cwd",
				scratch,
				"--timeout",
				"15",
				...args,
			],
			{
				env: {
					...process.env,
					PLINY_API_KEY: "test-cli-secret",
					PLINY_BASE_URL: `http://127.0.0.1:${mock.server.port}/api/llm`,
				},
				stdin: input === undefined ? "ignore" : "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (input !== undefined && child.stdin) {
			child.stdin.write(input);
			child.stdin.end();
		}
		const timer = setTimeout(() => child.kill(), 25000);
		try {
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exit, calls: mock.calls() };
		} finally {
			clearTimeout(timer);
		}
	} finally {
		mock.server.stop(true);
	}
}

test("pipeline files and stdin yield one schema-validated JSON envelope", async () => {
	await writeFile(
		join(scratch, "tests.log"),
		"FAILED test_mesh: expected 4, actual 5",
	);
	await writeFile(
		join(scratch, "schema.json"),
		JSON.stringify({
			type: "object",
			required: ["judgement"],
			properties: { judgement: { enum: ["fail", "pass"] } },
			additionalProperties: false,
		}),
	);
	const requests: string[] = [];
	const result = await run(
		[
			"--prompt",
			"Judge the test run",
			"--file",
			"tests.log",
			"--stdin",
			"--output-schema",
			"schema.json",
			"--json",
		],
		['{"judgement":"fail"}'],
		"metrics: 1 failure",
		(body) => requests.push(JSON.stringify(body)),
	);
	expect(result.stderr).not.toContain("test-cli-secret");
	expect(result.exit).toBe(0);
	expect(JSON.parse(result.stdout).result).toEqual({ judgement: "fail" });
	expect(requests[0]).toContain("FAILED test_mesh");
	expect(requests[0]).toContain("metrics: 1 failure");
}, 30000);

test("denied edits return needs_input and do not touch the workspace", async () => {
	const path = join(scratch, "denied.txt");
	const result = await run(
		["--prompt", "Write a file", "--json"],
		[{ name: "editor", input: { path, new_text: "should not exist" } }, "Done"],
	);
	expect(result.exit).toBe(3);
	expect(JSON.parse(result.stdout).status).toBe("needs_input");
	expect(await Bun.file(path).exists()).toBe(false);
}, 30000);

test("authorized artifact generation produces a real report and manifest", async () => {
	const artifacts = join(scratch, "reports");
	await mkdir(artifacts, { recursive: true });
	const path = join(artifacts, "report.md");
	const result = await run(
		[
			"--prompt",
			"Write a report",
			"--allow-tools",
			"--artifacts-dir",
			artifacts,
			"--json",
		],
		[
			{
				name: "editor",
				input: { path, new_text: "# CI report\nOne test failed.\n" },
			},
			"Report written.",
		],
	);
	if (result.exit !== 0) throw new Error(JSON.stringify(result));
	expect(result.exit).toBe(0);
	expect(await readFile(path, "utf8")).toContain("One test failed");
	expect(JSON.parse(result.stdout).artifacts[0].path).toBe(path);
}, 30000);

test("schema repair gets no tools and cannot return invalid output as success", async () => {
	const requests: Record<string, unknown>[] = [];
	const result = await run(
		[
			"--prompt",
			"Judge",
			"--output-schema",
			"schema.json",
			"--json",
			"--allow-tools",
		],
		["not JSON", '{"judgement":"unknown"}'],
		undefined,
		(body) => requests.push(body),
	);
	expect(result.exit).toBe(4);
	expect(JSON.parse(result.stdout).status).toBe("failed");
	expect(result.calls).toBe(2);
	expect(requests[1].tools ?? []).toEqual([]);
}, 30000);

test("unattended questions return structured needs_input", async () => {
	const result = await run(
		["--prompt", "Analyse", "--json"],
		[
			{
				name: "ask_question",
				input: { question: "Which baseline?", options: ["A", "B"] },
			},
			"No answer",
		],
	);
	expect(result.exit).toBe(3);
	expect(JSON.parse(result.stdout).pendingInput.question).toBe(
		"Which baseline?",
	);
}, 30000);

test("stream output consists only of event JSON lines", async () => {
	const result = await run(["--prompt", "Summarize", "--stream"], ["Summary"]);
	expect(result.exit).toBe(0);
	const events = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(events.some((e) => e.type === "text")).toBe(true);
	expect(events.at(-1).type).toBe("result");
}, 30000);

test("a stalled model request respects the turn timeout", async () => {
	const result = await run(
		["--prompt", "Summarize", "--timeout", "1", "--json"],
		[{ hang: true }],
	);
	expect(result.exit).toBe(124);
	expect(JSON.parse(result.stdout).error.code).toBe("timeout");
}, 30000);

test("iteration exhaustion is a failure, not a successful judgement", async () => {
	const result = await run(
		["--prompt", "Read", "--max-iterations", "1", "--json"],
		[{ name: "read_files", input: { paths: [schemaPath] } }],
	);
	expect(result.exit).toBe(1);
	expect(JSON.parse(result.stdout).status).toBe("failed");
}, 30000);

test("an authorized agent calls a stdio MCP server through the CLI", async () => {
	const config = join(scratch, "mcp.json");
	await writeFile(
		config,
		JSON.stringify({
			mcpServers: {
				fixture: {
					type: "stdio",
					command: runtime,
					args: [resolve(import.meta.dir, "fixtures/mcp-stdio.ts")],
				},
			},
		}),
	);
	const requests: string[] = [];
	const result = await run(
		[
			"--prompt",
			"Use the fixture",
			"--mcp-config",
			config,
			"--allow-tools",
			"--json",
		],
		[
			{ name: "fixture__echo", input: { value: "MCP evidence" } },
			"MCP completed",
		],
		undefined,
		(body) => requests.push(JSON.stringify(body)),
	);
	expect(result.exit).toBe(0);
	expect(requests[1]).toContain("MCP evidence");
}, 30000);

test("transcript export writes actual results without exporting the API key", async () => {
	const path = join(scratch, "transcript.md");
	const result = await run(
		["--prompt", "Summarize", "--export", path, "--json"],
		["Summary test-cli-secret"],
	);
	expect(result.exit).toBe(0);
	const transcript = await readFile(path, "utf8");
	expect(transcript).toContain("## user");
	expect(transcript).toContain("Summary [REDACTED]");
	expect(result.stdout).not.toContain("test-cli-secret");
}, 30000);

const python =
	process.platform === "win32" ? Bun.which("py") : Bun.which("python3");
test.skipIf(!process.env.PLINYCODE_TEST_ENTRY || !python)(
	"Python example invokes the portable CLI without a shell",
	async () => {
		const mock = gateway([
			'{"judgement":"fail","summary":"A test failed","evidence":["FAILED test_mesh"]}',
		]);
		const input = join(scratch, "python-input & metrics.log");
		await writeFile(input, "FAILED test_mesh");
		try {
			const child = Bun.spawn(
				[
					python ?? "python3",
					resolve(import.meta.dir, "../examples/analyse.py"),
					input,
				],
				{
					env: {
						...process.env,
						PATH: `${dirname(entry)}${delimiter}${process.env.PATH}`,
						PLINY_MODEL: model,
						PLINY_API_KEY: "fixture-secret",
						PLINY_BASE_URL: `http://127.0.0.1:${mock.server.port}/api/llm`,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
			expect(JSON.parse(stdout).result.judgement).toBe("fail");
		} finally {
			mock.server.stop(true);
		}
	},
	30000,
);
