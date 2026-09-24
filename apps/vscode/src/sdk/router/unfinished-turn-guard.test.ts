import type { AgentMessage } from "@plinycode/shared"
import { describe, expect, it } from "vitest"
import { createUnfinishedTurnGuard, looksUnfinished, UNFINISHED_TURN_REMINDER } from "./unfinished-turn-guard"

/** Endings of replies that stopped a run in real FreeAuto sessions, with how the task actually stood. */
const PREMATURE = [
	"Also, I should document everything clearly for the user.  Let me update the test script to be simpler and more focused on validation:",
	"Since this will take a significant amount of time to build and profile all cases, I'll start the process:",
	"I'll start the benchmark and then check the progress file to report status.  Let me start the profiling task using the correct tool:",
	"The user wants a status update on the benchmark. Let me check the master.log tail to see the current state.",
	"The user wants a status update. Let me check the master.log tail.",
	"Let me re-run the verification and inspect the report output to confirm everything is correct. I should read the relevant section of the report and a summary of the report.",
	'but the user said "git push origin" so I should handle it.  I\'ll commit the cross-case report generator and its output, then push to origin.',
]

const FINISHED = [
	"The detailed per-case hotspot reports with specific kernels, API breakdowns, and recommendations are all saved in the individual `report.md` files.",
	"Campaign completed as instructed in `AI_prompts\\run_surfer_target_cases.md`. No code was modified — this was a pure run-and-measure benchmark. ✅",
	"**Bottom line:** All 20 cases passed (10 `cpu_mt` + 10 `cuda`), report generated. Total runtime: **~1h 34m**. CUDA was **2.2× faster** overall than CPU_MT. Ready for review.",
	"I cannot sit in the chat for the full 7–10 hours, but **if you message me later I can read the finished logs and present the final results**. The background process will keep running on its own.",
	"`05_pd2d_single_thread` will follow. Estimated ~1 hour to full completion. The final `report.md` will be written automatically; you can re-run the report generator anytime to refresh partial results.",
	"The data clearly shows that **02_gabriel_cloud** provides the best overall performance improvements, while **03_levelset** should be investigated for its significant regressions.",
	"The commit included two new files that were staged:\n- scripts/dummy_task.py\n- scripts/run_dummy_task.bat\n\nIs there anything else you'd like me to do regarding these files or any other git operations?",
	"The push was successful. The commit removed the two script files that were previously added, and your changes are now on the remote repository.\n\nIs there anything else you'd like me to do?",
	"Its contents are now available in your working directory and are properly ignored by Git, meeting your requirement to have them untracked.\n\nIs there anything else you'd like me to do with these files?",
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
})

function reply(text: string): AgentMessage {
	return { id: "a", role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

describe("createUnfinishedTurnGuard", () => {
	const unfinished = reply("Let me check the log:")
	const done = reply("All tests pass.")

	it("nudges an unfinished reply and reports it", () => {
		const nudges: unknown[] = []
		const guard = createUnfinishedTurnGuard({ isActive: () => true, onNudge: (info) => nudges.push(info) })
		expect(guard({ message: unfinished, iteration: 4 })).toBe(UNFINISHED_TURN_REMINDER)
		expect(nudges).toEqual([{ excerpt: "Let me check the log:", nudgesThisRun: 1 }])
		expect(guard({ message: done, iteration: 9 })).toBeUndefined()
	})

	it("takes the reply right after a reminder at its word", () => {
		const guard = createUnfinishedTurnGuard({ isActive: () => true })
		expect(guard({ message: unfinished, iteration: 2 })).toBeDefined()
		expect(guard({ message: unfinished, iteration: 3 })).toBeUndefined()
		// Later in the same run a fresh stall is nudged again.
		expect(guard({ message: unfinished, iteration: 7 })).toBeDefined()
	})

	it("caps reminders per run and resets on the next run", () => {
		const guard = createUnfinishedTurnGuard({ isActive: () => true, maxNudgesPerRun: 2 })
		expect(guard({ message: unfinished, iteration: 2 })).toBeDefined()
		expect(guard({ message: unfinished, iteration: 5 })).toBeDefined()
		expect(guard({ message: unfinished, iteration: 8 })).toBeUndefined()
		// Iterations restart: a new run.
		expect(guard({ message: unfinished, iteration: 1 })).toBeDefined()
	})

	it("does nothing while inactive", () => {
		const guard = createUnfinishedTurnGuard({ isActive: () => false })
		expect(guard({ message: unfinished, iteration: 1 })).toBeUndefined()
	})
})
