/**
 * Find Files Executor
 *
 * Built-in implementation for locating files by name, so the model does not
 * have to shell out to `find`, `ls -R` or `dir /s`, whose syntax and output
 * differ per platform.
 */

import { spawn } from "node:child_process";
import type { AgentToolContext } from "@plinycode/shared";
import { getFileIndex } from "../../../services/workspace/file-indexer";
import type { FindFilesExecutor, SearchScope } from "../types";
import { createRipgrepResolver, type RipgrepPath } from "./ripgrep";
import { createGlobMatcher, resolveScope } from "./search";

/** Cap on buffered `rg --files` stdout; a listing past this is cut short. */
const MAX_RG_STDOUT_CHARS = 20 * 1024 * 1024;

/**
 * Options for the find-files executor
 */
export interface FindFilesExecutorOptions {
	/**
	 * Maximum number of paths returned per pattern
	 * @default 200
	 */
	maxResults?: number;

	/** A ripgrep binary to prefer over `rg` on PATH, for hosts that ship one. */
	rgPath?: RipgrepPath;

	/**
	 * How long ripgrep may take to list files before the fallback walk takes over.
	 * @default 15000
	 */
	rgTimeoutMs?: number;
}

/**
 * List files with ripgrep, which honors .gitignore. Paths come back relative
 * to cwd, under `target` when one is given. Resolves to null when ripgrep
 * could not answer.
 */
function listFilesWithRipgrep(
	command: string,
	cwd: string,
	target: string | undefined,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<string[] | null> {
	return new Promise((resolve) => {
		const child = spawn(
			command,
			["--files", "--hidden", "-g", "!.git", ...(target ? [target] : [])],
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				// Prevent a console window from flashing on Windows.
				windowsHide: true,
			},
		);

		let stdout = "";
		let settled = false;
		const finish = (result: string[] | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			resolve(result);
		};
		const timeout = setTimeout(() => finish(null), timeoutMs);

		if (signal?.aborted) {
			finish(null);
			return;
		}
		signal?.addEventListener("abort", () => finish(null));

		child.stdout.on("data", (chunk: Buffer | string) => {
			if (stdout.length <= MAX_RG_STDOUT_CHARS) {
				stdout += chunk.toString();
			}
		});
		child.stderr.on("data", () => {
			// Ignore stderr
		});
		child.on("close", (code: number | null) => {
			// 1 means the directory holds no files ripgrep would search.
			if (code !== 0 && code !== 1) {
				finish(null);
				return;
			}
			finish(
				stdout
					.split(/\r?\n/)
					.filter((line) => line.length > 0)
					.map((line) => line.replace(/\\/g, "/").replace(/^\.\//, "")),
			);
		});
		child.on("error", () => finish(null));
	});
}

/**
 * A pattern with wildcards is a glob. One without is text the path must
 * contain: a model that knows roughly what a file is called should not have
 * to guess the directory or the extension.
 */
function createPathMatcher(pattern: string): (filePath: string) => boolean {
	if (/[*?{[]/.test(pattern)) {
		return createGlobMatcher(pattern, { ignoreCase: true });
	}
	const needle = pattern.replace(/\\/g, "/").toLowerCase();
	return (filePath) => filePath.toLowerCase().includes(needle);
}

/**
 * Create a find-files executor
 *
 * @example
 * ```typescript
 * const findFiles = createFindFilesExecutor()
 * const result = await findFiles("*.test.ts", "/path/to/project", context, { path: "src" })
 * ```
 */
export function createFindFilesExecutor(
	options: FindFilesExecutorOptions = {},
): FindFilesExecutor {
	const { maxResults = 200, rgPath, rgTimeoutMs = 15_000 } = options;
	const resolveRipgrep = createRipgrepResolver(rgPath);

	return async (
		pattern: string,
		cwd: string,
		context: AgentToolContext,
		searchScope?: Pick<SearchScope, "path">,
	): Promise<string> => {
		if (context.signal?.aborted) {
			throw new Error("Find files operation aborted");
		}
		const trimmed = pattern.trim();
		if (trimmed.length === 0) {
			throw new Error(
				"Empty pattern. Give a glob such as *.ts, or part of a file name.",
			);
		}

		const scope = await resolveScope(cwd, { path: searchScope?.path });
		if (scope.file) {
			throw new Error(
				`${searchScope?.path} is a file. Set path to a directory, or omit it to look in the whole workspace.`,
			);
		}

		const command = await resolveRipgrep();
		let files = command
			? await listFilesWithRipgrep(
					command,
					cwd,
					scope.target,
					rgTimeoutMs,
					context.signal,
				)
			: null;
		if (context.signal?.aborted) {
			throw new Error("Find files operation aborted");
		}
		// Without ripgrep, walk the directory: no .gitignore, but the usual
		// dependency and build folders are skipped.
		files ??= Array.from(
			await getFileIndex(scope.root),
			(relativePath) => `${scope.displayPrefix}${relativePath}`,
		);

		const matches = createPathMatcher(trimmed);
		const found = files.filter(matches).sort();
		const where = searchScope?.path?.trim()
			? ` in ${searchScope.path.trim()}`
			: "";

		if (found.length === 0) {
			return (
				`No files match ${trimmed}${where} (${files.length} files looked at).\n` +
				"Matching ignores case. A pattern without wildcards matches any part of the path; " +
				"with wildcards, *.ts matches by file name in any directory and src/**/*.ts matches from the workspace root."
			);
		}

		const shown = found.slice(0, maxResults);
		const header =
			found.length > shown.length
				? `Found ${found.length} files matching ${trimmed}${where}; showing the first ${shown.length}. Narrow the pattern or set path to see the rest.`
				: `Found ${found.length} file${found.length === 1 ? "" : "s"} matching ${trimmed}${where}:`;
		return [header, ...shown].join("\n");
	};
}
