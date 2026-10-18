import { describe, expect, it } from "vitest";
import { LoopDetectionTracker } from "./loop-detection";

const read = (path: string) => ({
	name: "read_files",
	input: { files: [{ path }] },
});

describe("LoopDetectionTracker", () => {
	it("warns at the soft threshold and stops at the hard one for consecutive identical calls", () => {
		const tracker = new LoopDetectionTracker({
			softThreshold: 3,
			hardThreshold: 5,
		});
		expect(tracker.inspect(read("a"), 1).kind).toBe("ok");
		expect(tracker.inspect(read("a"), 2).kind).toBe("ok");
		expect(tracker.inspect(read("a"), 3)).toMatchObject({ kind: "soft" });
		expect(tracker.inspect(read("a"), 4).kind).toBe("ok");
		expect(tracker.inspect(read("a"), 5)).toMatchObject({ kind: "hard" });
	});

	it("notices the third identical call of a run even with other calls in between, once", () => {
		const tracker = new LoopDetectionTracker();
		expect(tracker.inspect(read("a"), 1).kind).toBe("ok");
		expect(tracker.inspect(read("b"), 2).kind).toBe("ok");
		expect(tracker.inspect(read("a"), 3).kind).toBe("ok");
		expect(tracker.inspect(read("c"), 4).kind).toBe("ok");
		const verdict = tracker.inspect(read("a"), 5);
		expect(verdict.kind).toBe("soft");
		expect(verdict.message).toContain(
			"3rd call to `read_files` with the same arguments this run, first at step 1",
		);
		expect(tracker.inspect(read("d"), 6).kind).toBe("ok");
		// A fourth repeat is not announced again, and never stops the run.
		expect(tracker.inspect(read("a"), 7).kind).toBe("ok");
	});

	it("forgets the run's repeats on reset", () => {
		const tracker = new LoopDetectionTracker();
		tracker.inspect(read("a"), 1);
		tracker.inspect(read("b"), 2);
		tracker.inspect(read("a"), 3);
		tracker.reset();
		tracker.inspect(read("b"), 1);
		expect(tracker.inspect(read("a"), 2).kind).toBe("ok");
	});
});
