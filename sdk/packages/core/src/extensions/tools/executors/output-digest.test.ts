import { describe, expect, it } from "vitest";
import {
	COMMAND_DIGEST_THRESHOLD_CHARS,
	digestCommandOutput,
} from "./output-limits";

function buildLog(): string {
	const lines: string[] = [];
	for (let i = 0; i < 3000; i += 1) {
		lines.push(`[${i}/3000] Building object file number ${i}.cxx.obj`);
	}
	lines[1500] =
		"src/Foo.cxx(42): error C2512: 'X': no appropriate default constructor";
	lines[1800] = "0 errors, 0 warnings";
	lines.push("ninja: build stopped: subcommand failed.");
	return lines.join("\n");
}

describe("digestCommandOutput", () => {
	it("returns short output unchanged", () => {
		const text = "line\n".repeat(100);
		expect(digestCommandOutput(text)).toBe(text);
	});

	it("keeps the error in the middle, with its line number, and the tail", () => {
		const log = buildLog();
		expect(log.length).toBeGreaterThan(COMMAND_DIGEST_THRESHOLD_CHARS);
		const digest = digestCommandOutput(log, { savedTo: "C:\tmpout.txt" });
		expect(digest).toContain("1501: src/Foo.cxx(42): error C2512");
		expect(digest).toContain("ninja: build stopped: subcommand failed.");
		expect(digest).toContain("C:\tmpout.txt");
		expect(digest).toContain("[1/3000] Building");
		expect(digest).not.toContain("1801: 0 errors");
		expect(digest.length).toBeLessThan(14_000);
		expect(digest.length).toBeLessThan(log.length / 5);
	});

	it("caps the diagnostic lines it shows and says how many it dropped", () => {
		const lines = Array.from(
			{ length: 4000 },
			(_, i) => `test ${i} failed: assertion mismatch in module ${i}`,
		);
		const digest = digestCommandOutput(lines.join("\n"));
		expect(digest.length).toBeLessThan(14_000);
		expect(digest).toMatch(
			/Showing the first lines, \d+ of \d+ error\/failure lines/,
		);
	});
});
