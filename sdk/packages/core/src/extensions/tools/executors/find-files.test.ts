import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import { createFindFilesExecutor } from "./find-files";

const ctx: AgentToolContext = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

/**
 * A ripgrep that cannot run, so the listing comes from the executor's own
 * walk whether or not the machine running the tests has `rg` on PATH.
 */
const NO_RIPGREP = path.join(os.tmpdir(), "no-such-ripgrep-binary");

async function withWorkspace(
	files: string[],
	run: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-find-"));
	try {
		for (const name of files) {
			const filePath = path.join(dir, name);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, "", "utf-8");
		}
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const FILES = [
	"README.md",
	"src/router/router-policy.ts",
	"src/router/router-policy.test.ts",
	"src/Engine.CC",
	"rtl/top.sv",
	"node_modules/pkg/index.ts",
];

describe("createFindFilesExecutor", () => {
	it("matches a bare glob by file name in any directory, ignoring case", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			await expect(findFiles("*.cc", dir, ctx)).resolves.toBe(
				"Found 1 file matching *.cc:\nsrc/Engine.CC",
			);
		});
	});

	it("matches a glob with a slash from the workspace root", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			await expect(findFiles("src/**/*.test.ts", dir, ctx)).resolves.toBe(
				"Found 1 file matching src/**/*.test.ts:\nsrc/router/router-policy.test.ts",
			);
		});
	});

	it("treats a pattern without wildcards as part of the path", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			await expect(findFiles("Router-Policy", dir, ctx)).resolves.toBe(
				[
					"Found 2 files matching Router-Policy:",
					"src/router/router-policy.test.ts",
					"src/router/router-policy.ts",
				].join("\n"),
			);
		});
	});

	it("looks only under path, and reports paths from the workspace root", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			await expect(findFiles("*", dir, ctx, { path: "rtl" })).resolves.toBe(
				"Found 1 file matching * in rtl:\nrtl/top.sv",
			);
		});
	});

	it("leaves dependency folders out", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			const result = await findFiles("*.ts", dir, ctx);

			expect(result).toContain("src/router/router-policy.ts");
			expect(result).not.toContain("node_modules");
		});
	});

	it("caps the list and says how many there were", async () => {
		const many = Array.from({ length: 12 }, (_, i) => `gen/f${i}.txt`);
		await withWorkspace(many, async (dir) => {
			const findFiles = createFindFilesExecutor({
				rgPath: NO_RIPGREP,
				maxResults: 5,
			});

			const result = await findFiles("*.txt", dir, ctx);

			expect(result.split("\n")).toHaveLength(6);
			expect(result).toContain(
				"Found 12 files matching *.txt; showing the first 5.",
			);
		});
	});

	it("explains how patterns match when nothing is found", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			const result = await findFiles("*.proto", dir, ctx);

			expect(result).toContain("No files match *.proto (5 files looked at).");
			expect(result).toContain("A pattern without wildcards matches");
		});
	});

	it("rejects a path that is a file, a missing path and an empty pattern", async () => {
		await withWorkspace(FILES, async (dir) => {
			const findFiles = createFindFilesExecutor({ rgPath: NO_RIPGREP });

			await expect(
				findFiles("*", dir, ctx, { path: "README.md" }),
			).rejects.toThrow("README.md is a file");
			await expect(findFiles("*", dir, ctx, { path: "nope" })).rejects.toThrow(
				"Search path not found: nope",
			);
			await expect(findFiles("  ", dir, ctx)).rejects.toThrow("Empty pattern");
		});
	});
});
