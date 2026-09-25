import type { AgentMessage } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import {
	endsWithPlanList,
	latestUserRequest,
	looksDegenerate,
	looksLikeLeakedReasoning,
	looksLikeReadinessInsteadOfAction,
	looksLikeWaitBailOut,
	looksUnfinished,
	previousShellFailure,
	shellFailureFromResult,
} from "./unfinished-turn-guard"

/** Endings of replies that stopped a run in real FreeAuto sessions, with how the task actually stood. */
const PREMATURE = [
	"Also, I should document everything clearly for the user.  Let me update the test script to be simpler and more focused on validation:",
	"Since this will take a significant amount of time to build and profile all cases, I'll start the process:",
	"I'll start the benchmark and then check the progress file to report status.  Let me start the profiling task using the correct tool:",
	"The user wants a status update on the benchmark. Let me check the master.log tail to see the current state.",
	"The user wants a status update. Let me check the master.log tail.",
	"Let me re-run the verification and inspect the report output to confirm everything is correct. I should read the relevant section of the report and a summary of the report.",
	'but the user said "git push origin" so I should handle it.  I\'ll commit the cross-case report generator and its output, then push to origin.',
	"Let me check the current status of the benchmark runs and any collected data:",
]

const FINISHED = [
	"The detailed per-case hotspot reports with specific kernels, API breakdowns, and recommendations are all saved in the individual `report.md` files.",
	"Campaign completed as instructed in `AI_prompts\\run_surfer_target_cases.md`. No code was modified — this was a pure run-and-measure benchmark. ✅",
	"**Bottom line:** All 20 cases passed (10 `cpu_mt` + 10 `cuda`), report generated. Total runtime: **~1h 34m**. CUDA was **2.2× faster** overall than CPU_MT. Ready for review.",
	"The data clearly shows that **02_gabriel_cloud** provides the best overall performance improvements, while **03_levelset** should be investigated for its significant regressions.",
	"The commit included two new files that were staged:\n- scripts/dummy_task.py\n- scripts/run_dummy_task.bat\n\nIs there anything else you'd like me to do regarding these files or any other git operations?",
	"The push was successful. The commit removed the two script files that were previously added, and your changes are now on the remote repository.\n\nIs there anything else you'd like me to do?",
	"Its contents are now available in your working directory and are properly ignored by Git, meeting your requirement to have them untracked.\n\nIs there anything else you'd like me to do with these files?",
	"The report is written to D:\\dev0\\GPUSurfer\\ai_output\\profile_nsight\\20260923_173521\\cross_case_report.md",
	"Committed as `a1b2c3d` and pushed to `origin/lgiaccar/pipeline_perf_tests`.",
]

/** Replies that promised to come back later — which a model cannot do. */
const WAIT_BAIL_OUTS = [
	"The 10-minute timer is running in the background. I'll check results at the 15:08 mark.",
	"I'll check again at **15:28** to catch GR9hA completion, and then at **15:37–15:42** for the final all-complete report. Stand by!",
	"I cannot sit in the chat for the full 7–10 hours, but **if you message me later I can read the finished logs and present the final results**. The background process will keep running on its own.",
	"In the meantime, there's nothing to do but wait for GR9hA to either complete or timeout. The automated bisect is working — each round takes ~15 min and there are ~3 rounds remaining. Total time remaining: approximately **30-45 minutes**.",
	"Actually, I should NOT make more tool calls now because it will break my 10-minute cadence. Let me just wait.",
]

/** Status reports that are legitimate final answers to "status?". */
const STATUS_REPORTS = [
	"Estimated completion: ~4–5 more hours (5 branches remaining, ~50 min each).\n\n### Live monitoring\n```powershell\nGet-Content -Path master.log -Wait -Tail 10\n```",
	"`05_pd2d_single_thread` will follow. Estimated ~1 hour to full completion. The final `report.md` will be written automatically; you can re-run the report generator anytime to refresh partial results.",
]

describe("looksUnfinished", () => {
	it.each(PREMATURE)("flags a reply that announces a step it did not take: %s", (text) => {
		expect(looksUnfinished(text)).toBe(true)
	})

	it.each(FINISHED)("accepts a genuine final answer: %s", (text) => {
		expect(looksUnfinished(text)).toBe(false)
	})

	it("accepts a question or an offer handed back to the user", () => {
		expect(looksUnfinished("I can run the full suite next. Should I go ahead?")).toBe(false)
		expect(looksUnfinished("I'll be here — let me know if you need anything else.")).toBe(false)
		expect(looksUnfinished("")).toBe(false)
	})

	// kimi-k2.6 endings from the 2026-09-25 benchmark session: the plan was
	// the whole reply, and the first step's tool call never came.
	it.each(PLAN_LISTS)("flags a reply that ends on the model's own to-do list: %s", (text) => {
		expect(looksUnfinished(text)).toBe(true)
		expect(endsWithPlanList(text)).toBe(true)
	})

	it("accepts a results list, a list of options for the user, and a plan followed by a result", () => {
		expect(looksUnfinished("Results so far:\n- stage: 476.6 s, 18.6 GB peak\n- 14_pd2d: 471.2 s, 18.5 GB peak")).toBe(false)
		expect(looksUnfinished("You could go two ways:\n1. Run the full suite overnight\n2. Run only the GR9hA case now")).toBe(
			false,
		)
		expect(
			looksUnfinished(
				"I need to:\n1. Check what's running\n2. Read the logs\n\nAll four bench_stage cases have completed and their metrics are in the table above.",
			),
		).toBe(false)
		expect(endsWithPlanList("I need to:\n1. Check the logs")).toBe(false)
	})
})

const PLAN_LISTS = [
	"The system is reminding me that I keep saying what I'll do but not actually calling tools. I need to just do it.\n\nLet me check the current status of the running tests by calling the appropriate tools. I should:\n1. Check for running processes\n2. Check what's in the log files\n3. Report the current status to the user",
	"Let me actually make the tool calls to check the current status of the tests. I need to:\n1. Check what's currently running\n2. Check what logs exist\n3. Extract results from completed logs\n4. Give a clear status update",
	"Let me continue adding content to the script file. I need to:\n- Complete the Run-SingleTest function (timing parsing and return logic)\n- Add the main execution loop where we iterate through branches and tests\n- Add the results summary and output logic",
	"Here's the plan:\n1) **Verify** the CUDA build exists\n2) **Run** the four cases on bench_stage",
]

describe("looksLikeWaitBailOut", () => {
	it.each(WAIT_BAIL_OUTS)("flags a promise to come back later: %s", (text) => {
		expect(looksLikeWaitBailOut(text)).toBe(true)
	})

	it.each([...FINISHED, ...STATUS_REPORTS])("accepts a real answer or status report: %s", (text) => {
		expect(looksLikeWaitBailOut(text)).toBe(false)
	})
})

describe("looksLikeLeakedReasoning", () => {
	it("flags a reply that argues with itself and trails off", () => {
		expect(
			looksLikeLeakedReasoning(
				"Are these still running benchmarks? Let me check. Actually, I should kill them all first to ensure a clean slate, then launch ONE benchmark. Hmm, but I just killed all PowerShell after 3:30 AM in",
			),
		).toBe(true)
	})

	it("flags a reply that narrates what the user wants instead of acting", () => {
		expect(
			looksLikeLeakedReasoning(
				"The user wants a status update. The user asked for the benchmark results and whether anything has run.",
			),
		).toBe(true)
	})

	it("flags a long prose line that ends mid-sentence", () => {
		expect(
			looksLikeLeakedReasoning(
				"So the next thing to do is to rebuild the CUDA target and rerun the two failing cases with the",
			),
		).toBe(true)
	})

	it.each([...FINISHED, ...STATUS_REPORTS])("accepts a finished answer: %s", (text) => {
		expect(looksLikeLeakedReasoning(text)).toBe(false)
	})

	it("accepts lists, tables, code fences and short headings as endings", () => {
		expect(looksLikeLeakedReasoning("Changed files:\n- src/a.ts\n- src/b.ts")).toBe(false)
		expect(looksLikeLeakedReasoning("| Case | Time |\n| --- | --- |\n| GR9hA | 569.7s |")).toBe(false)
		expect(looksLikeLeakedReasoning("Run it with:\n```sh\nbun test\n```")).toBe(false)
	})
})

describe("looksDegenerate", () => {
	it("flags thousands of repeated dots or brackets", () => {
		const dots = `Good, we're on stage. Let me verify: ]]]]}]${" .  ".repeat(3500)}`
		expect(looksDegenerate(dots)).toBe(true)
		expect(looksDegenerate(`${"]".repeat(2500)}`)).toBe(true)
	})

	it("accepts long legitimate output such as tables and JSON", () => {
		const table = Array.from(
			{ length: 80 },
			(_, row) => `| case_${row} | ${row * 13.7}s | ${row % 3 === 0 ? "PASS" : "FAIL"} | ${row * 1024} MB |`,
		).join("\n")
		expect(looksDegenerate(table)).toBe(false)
		const json = JSON.stringify(
			Array.from({ length: 200 }, (_, index) => ({ id: index, name: `item-${index}`, ok: index % 2 === 0 })),
		)
		expect(looksDegenerate(json)).toBe(false)
	})

	it("ignores short replies", () => {
		expect(looksDegenerate(". . . . . .")).toBe(false)
	})
})

describe("looksLikeReadinessInsteadOfAction", () => {
	const ready =
		"The benchmark is ready to run immediately and will handle all the requirements including measuring wall time, mesh time, and memory consumption."

	it("flags 'ready to run' when the user asked to run it", () => {
		expect(looksLikeReadinessInsteadOfAction(ready, "please build in CUDA mode and run the GR9hA performance case")).toBe(
			true,
		)
	})

	it("accepts it when the user only asked for the script, or when it asks the user", () => {
		expect(looksLikeReadinessInsteadOfAction(ready, "write me a benchmark script")).toBe(false)
		expect(looksLikeReadinessInsteadOfAction(`${ready} Would you like me to run it now?`, "run the benchmark")).toBe(false)
	})
})

function tool(toolName: string, output: unknown, isError?: boolean): AgentMessage {
	return {
		id: "t",
		role: "tool",
		content: [{ type: "tool-result", toolCallId: "c1", toolName, output, ...(isError ? { isError } : {}) }],
		createdAt: 0,
	}
}

const reply: AgentMessage = { id: "a", role: "assistant", content: [{ type: "text", text: "It failed." }], createdAt: 0 }

describe("shellFailureFromResult / previousShellFailure", () => {
	it("reads a failed command from the shell tool's structured result", () => {
		const message = tool("run_commands", [
			{ query: "echo ok", result: "ok", success: true },
			{
				query: "gh auth token",
				result: "[Command exited with code 1]\nno oauth token found",
				error: "Command exited with code 1",
				success: false,
			},
		])
		expect(previousShellFailure([message, reply], reply)).toEqual({
			kind: "failed",
			tool: "run_commands",
			command: "gh auth token",
			exitCode: 1,
		})
	})

	it("reads a detached command and where its output goes", () => {
		const text =
			"The command was still starting or running after 300 seconds, so Cline automatically proceeded while leaving it running in the terminal.\n" +
			"This is partial output; further output is being redirected to this file, which you can read to check progress: C:\\tmp\\proceed-1.log\nOutput so far:\n[1/229] Building"
		const message = tool("run_commands", [{ query: "gpu_surfer_make.bat", result: text, success: true }])
		expect(previousShellFailure([message, reply], reply)).toEqual({
			kind: "detached",
			tool: "run_commands",
			command: "gpu_surfer_make.bat",
			logPath: "C:\\tmp\\proceed-1.log",
		})
	})

	it("treats an error-flagged string result as a failure and ignores other tools", () => {
		expect(
			shellFailureFromResult({
				type: "tool-result",
				toolCallId: "c",
				toolName: "run_commands",
				output: "boom",
				isError: true,
			}),
		).toEqual({
			kind: "failed",
			tool: "run_commands",
		})
		expect(
			shellFailureFromResult({
				type: "tool-result",
				toolCallId: "c",
				toolName: "read_files",
				output: "[Command exited with code 1]",
			}),
		).toBeUndefined()
	})

	it("only looks at the message right before the reply", () => {
		const failed = tool("run_commands", [{ query: "x", result: "", error: "Command exited with code 1", success: false }])
		const ok = tool("run_commands", [{ query: "y", result: "fine", success: true }])
		expect(previousShellFailure([failed, ok, reply], reply)).toBeUndefined()
		expect(previousShellFailure([ok, failed, reply], reply)).toBeDefined()
		expect(previousShellFailure(undefined, reply)).toBeUndefined()
	})
})

describe("latestUserRequest", () => {
	const user = (text: string, metadata?: Record<string, unknown>): AgentMessage => ({
		id: "u",
		role: "user",
		content: [{ type: "text", text }],
		createdAt: 0,
		...(metadata ? { metadata } : {}),
	})

	it("returns the last real user prompt, unwrapped, skipping reminders and tool results", () => {
		const messages = [
			user('<user_input mode="act">build and run the benchmark</user_input>'),
			reply,
			tool("run_commands", [{ query: "make", result: "ok", success: true }]),
			user("[SYSTEM] Call the tool.", { userRunSpan: 0, displayRole: "system" }),
			reply,
		]
		expect(latestUserRequest(messages)).toBe("build and run the benchmark")
		expect(latestUserRequest(undefined)).toBe("")
	})
})
