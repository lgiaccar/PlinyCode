/**
 * Search Executor
 *
 * Built-in implementation for searching the codebase using ripgrep (if available) or regex.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@plinycode/shared";
import { getFileIndex } from "../../../services/workspace/file-indexer";
import type { SearchExecutor, SearchScope } from "../types";
import { MAX_LINE_CHARS, MAX_SEARCH_OUTPUT_CHARS } from "./output-limits";
import { createRipgrepResolver, type RipgrepPath } from "./ripgrep";

/**
 * Cap on buffered `rg --json` stdout. Each event embeds the full text of its
 * matched line, so one match in a giant single-line file (e.g. a serialized
 * trace dump) can produce a multi-hundred-MB event; buffering unbounded can
 * exceed the engine's max string length and crash the whole process with an
 * uncaught RangeError from the stream data handler. Results are capped to
 * MAX_SEARCH_OUTPUT_CHARS anyway, so output past this is never shown.
 */
const MAX_RG_STDOUT_CHARS = 10 * 1024 * 1024;

/** Files larger than this are skipped by the fallback scan. */
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Options for the search executor
 */
export interface SearchExecutorOptions {
	/**
	 * Restrict the fallback scan to these file extensions (without dot).
	 * @default every file that does not look binary
	 */
	includeExtensions?: string[];

	/**
	 * Directories to exclude from search
	 * @default ["node_modules", ".git", "dist", "build", ".next", "coverage"]
	 */
	excludeDirs?: string[];

	/**
	 * Maximum number of results to return
	 * @default 100
	 */
	maxResults?: number;

	/**
	 * Maximum number of results shown per file, so that one file full of
	 * matches does not crowd out every other file. Not applied when the
	 * search is scoped to a single file.
	 * @default 10
	 */
	maxMatchesPerFile?: number;

	/**
	 * Number of context lines before and after match
	 * @default 2
	 */
	contextLines?: number;

	/**
	 * Maximum depth to traverse
	 * @default 20
	 */
	maxDepth?: number;

	/** A ripgrep binary to prefer over `rg` on PATH, for hosts that ship one. */
	rgPath?: RipgrepPath;

	/**
	 * How long ripgrep may run before the fallback scan takes over.
	 * @default 20000
	 */
	rgTimeoutMs?: number;
}

/**
 * Extensions the fallback scan never opens. It otherwise reads every file:
 * an allow-list of "code" extensions silently returned nothing for whatever
 * language it had left out (.cc, .sv, .tcl, .cs, .proto, …).
 */
const BINARY_EXTENSIONS = new Set([
	"7z",
	"a",
	"avi",
	"bin",
	"bmp",
	"bz2",
	"class",
	"dat",
	"db",
	"dll",
	"dmg",
	"doc",
	"docx",
	"dylib",
	"eot",
	"exe",
	"gif",
	"gz",
	"ico",
	"iso",
	"jar",
	"jpeg",
	"jpg",
	"lib",
	"lockb",
	"mov",
	"mp3",
	"mp4",
	"o",
	"obj",
	"otf",
	"pdb",
	"pdf",
	"png",
	"ppt",
	"pptx",
	"pyc",
	"so",
	"sqlite",
	"tar",
	"tgz",
	"ttf",
	"vsix",
	"wasm",
	"wav",
	"webm",
	"webp",
	"woff",
	"woff2",
	"xls",
	"xlsx",
	"xz",
	"zip",
]);

const DEFAULT_EXCLUDE_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	".turbo",
	".output",
	"out",
	"target",
	"bin",
	"obj",
];

/**
 * Search result for a single file match
 */
interface SearchMatch {
	file: string;
	line: number;
	column: number;
	match: string;
	context: string[];
}

interface SearchOutcome {
	matches: SearchMatch[];
	/** Files that had more matches than were kept. */
	cappedFiles: string[];
	/** Files the fallback scan opened; undefined for ripgrep. */
	filesSearched?: number;
}

function contextLine(marker: ">" | " ", lineNumber: number, text: string) {
	return `${marker} ${lineNumber}: ${text.replace(/\r?\n$/, "").slice(0, MAX_LINE_CHARS)}`;
}

interface RipgrepRequest {
	command: string;
	query: string;
	cwd: string;
	/** File or directory to search, as ripgrep should be given it. */
	target?: string;
	glob?: string;
	maxResults: number;
	maxMatchesPerFile: number;
	contextLines: number;
	timeoutMs: number;
	abortSignal?: AbortSignal;
}

/**
 * Turn `rg --json` events into matches. Ripgrep reports a file as `begin`,
 * then `context` and `match` events in line order, then `end`; a context
 * line can sit after one match and before the next. Exported for tests.
 */
export function parseRipgrepEvents(
	stdout: string,
	request: Pick<
		RipgrepRequest,
		"maxResults" | "maxMatchesPerFile" | "contextLines"
	>,
): SearchOutcome {
	const matches: SearchMatch[] = [];
	const cappedFiles: string[] = [];
	let leading: { line: number; text: string }[] = [];
	let lastInFile: SearchMatch | undefined;
	let countInFile = 0;

	// Drop the trailing partial event left behind by the stdout cap.
	const events = stdout
		.slice(0, stdout.lastIndexOf("\n") + 1)
		.split("\n")
		.filter((line) => line.trim());

	for (const event of events) {
		const json = JSON.parse(event);
		if (json.type === "begin") {
			leading = [];
			lastInFile = undefined;
			countInFile = 0;
			continue;
		}
		const data = json.data;
		const text: string | undefined = data?.lines?.text;
		if (json.type === "context" && text !== undefined) {
			const line: number = data.line_number;
			if (lastInFile && line <= lastInFile.line + request.contextLines) {
				lastInFile.context.push(contextLine(" ", line, text));
			} else {
				leading.push({ line, text });
			}
			continue;
		}
		if (json.type !== "match" || text === undefined) {
			continue;
		}
		const file = String(data.path?.text ?? "").replace(/\\/g, "/");
		const line: number = data.line_number;
		const before = leading.filter(
			(entry) => entry.line >= line - request.contextLines,
		);
		leading = [];
		countInFile++;
		if (countInFile > request.maxMatchesPerFile) {
			if (countInFile === request.maxMatchesPerFile + 1) {
				cappedFiles.push(file);
			}
			lastInFile = undefined;
			continue;
		}
		if (matches.length >= request.maxResults) {
			break;
		}
		const submatch = data.submatches?.[0];
		lastInFile = {
			file,
			line,
			column: (submatch?.start ?? 0) + 1,
			match: submatch?.match?.text ?? "",
			context: [
				...before.map((entry) => contextLine(" ", entry.line, entry.text)),
				contextLine(">", line, text),
			],
		};
		matches.push(lastInFile);
	}

	return { matches, cappedFiles };
}

/**
 * Run ripgrep. Resolves to null when ripgrep could not answer (it failed to
 * start, timed out, or rejected the pattern), which sends the caller to the
 * fallback scan; "no matches" is an answer, with an empty list.
 */
function searchWithRipgrep(
	request: RipgrepRequest,
): Promise<SearchOutcome | null> {
	return new Promise((resolve) => {
		const args = [
			"--json",
			`--context=${request.contextLines}`,
			// One more than is shown, to learn that a file has more.
			`--max-count=${request.maxMatchesPerFile + 1}`,
			"-i",
			...(request.glob ? ["--glob", request.glob] : []),
			// -e keeps a pattern that starts with "-" from being read as a flag.
			"-e",
			request.query,
			...(request.target ? [request.target] : []),
		];
		const child = spawn(request.command, args, {
			cwd: request.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Prevent a console window from flashing on Windows.
			windowsHide: true,
		});

		let stdout = "";
		let resolved = false;

		const cleanup = () => {
			if (!child.killed) {
				child.kill("SIGTERM");
			}
		};

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				cleanup();
				resolve(null);
			}
		}, request.timeoutMs);

		const finalize = (result: SearchOutcome | null) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				cleanup();
				resolve(result);
			}
		};

		if (request.abortSignal?.aborted) {
			finalize(null);
			return;
		}

		request.abortSignal?.addEventListener("abort", () => {
			finalize(null);
		});

		child.stdout.on("data", (chunk: Buffer | string) => {
			if (stdout.length > MAX_RG_STDOUT_CHARS) {
				return;
			}
			stdout += chunk.toString();
		});

		child.stderr.on("data", () => {
			// Ignore stderr
		});

		child.on("close", (code: number | null) => {
			// 0: matches, 1: none. Anything else is an error, such as a pattern
			// ripgrep's regex engine does not support.
			if (code === 0 || code === 1) {
				try {
					finalize(parseRipgrepEvents(stdout, request));
				} catch {
					finalize(null);
				}
				return;
			}

			finalize(null);
		});

		child.on("error", () => {
			finalize(null);
		});
	});
}

/**
 * A small gitignore-style glob, for the fallback scan to filter files the way
 * ripgrep's --glob does: `*`, `?`, `**`, `{a,b}` and a leading `!` to
 * exclude. A glob without a slash matches the file name in any directory; one
 * with a slash matches the path from the workspace root.
 */
export function createGlobMatcher(
	glob: string,
	options: { ignoreCase?: boolean } = {},
): (filePath: string) => boolean {
	const ignoreCase = options.ignoreCase ?? process.platform === "win32";
	const trimmed = glob.trim();
	const negated = trimmed.startsWith("!");
	let pattern = (negated ? trimmed.slice(1) : trimmed)
		.replace(/\\/g, "/")
		.replace(/^\.\//, "");
	const anchored = pattern.includes("/");
	pattern = pattern.replace(/^\//, "");

	let source = "";
	let braceDepth = 0;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				index++;
				if (pattern[index + 1] === "/") {
					index++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else if (char === "{") {
			braceDepth++;
			source += "(?:";
		} else if (char === "}" && braceDepth > 0) {
			braceDepth--;
			source += ")";
		} else if (char === "," && braceDepth > 0) {
			source += "|";
		} else {
			source += char.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
		}
	}
	source += ")".repeat(braceDepth);

	const regex = new RegExp(
		`^${anchored ? "" : "(?:.*/)?"}${source}$`,
		ignoreCase ? "i" : "",
	);
	return (filePath) => regex.test(filePath) !== negated;
}

function shouldIncludeFile(
	relativePath: string,
	excludeDirs: Set<string>,
	includeExtensions: Set<string> | undefined,
	maxDepth: number,
): boolean {
	const segments = relativePath.split("/");
	const fileName = segments[segments.length - 1] ?? "";
	const directoryDepth = segments.length - 1;

	if (directoryDepth > maxDepth) {
		return false;
	}

	for (let i = 0; i < segments.length - 1; i++) {
		if (excludeDirs.has(segments[i] ?? "")) {
			return false;
		}
	}

	const ext = path.posix.extname(fileName).slice(1).toLowerCase();
	if (includeExtensions) {
		return includeExtensions.has(ext) || (!ext && !fileName.startsWith("."));
	}
	return !BINARY_EXTENSIONS.has(ext);
}

export interface ResolvedScope {
	/** Directory the search walks, or the directory holding `file`. */
	root: string;
	/** Set when the search is scoped to one file. */
	file?: string;
	/** What ripgrep is given, relative to cwd when the scope is inside it. */
	target?: string;
	/** Prefix that turns a path relative to `root` into the path to report. */
	displayPrefix: string;
	glob?: (filePath: string) => boolean;
	rawGlob?: string;
}

export async function resolveScope(
	cwd: string,
	scope: SearchScope | undefined,
): Promise<ResolvedScope> {
	const rawGlob = scope?.glob?.trim() || undefined;
	const glob = rawGlob ? createGlobMatcher(rawGlob) : undefined;
	const rawPath = scope?.path?.trim();
	if (!rawPath || rawPath === ".") {
		return { root: cwd, displayPrefix: "", glob, rawGlob };
	}

	const absolute = path.resolve(cwd, rawPath);
	const stats = await fs.stat(absolute).catch(() => undefined);
	if (!stats) {
		throw new Error(
			`Search path not found: ${rawPath}. Give a file or directory that exists, relative to ${cwd} or absolute.`,
		);
	}

	// Report paths the way the rest of the tools take them: relative to cwd
	// inside the workspace, absolute outside it.
	const relative = path.relative(cwd, absolute);
	const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
	const display = (inside ? relative : absolute).split(path.sep).join("/");
	if (stats.isFile()) {
		return {
			root: path.dirname(absolute),
			file: absolute,
			target: display,
			displayPrefix: display,
			glob,
			rawGlob,
		};
	}
	return {
		root: absolute,
		target: display || undefined,
		displayPrefix: display ? `${display.replace(/\/$/, "")}/` : "",
		glob,
		rawGlob,
	};
}

/**
 * Create a search executor using regex pattern matching
 *
 * @example
 * ```typescript
 * const search = createSearchExecutor({
 *   maxResults: 50,
 *   contextLines: 3,
 * })
 *
 * const results = await search("function\\s+handleClick", "/path/to/project", context)
 * ```
 */
export function createSearchExecutor(
	options: SearchExecutorOptions = {},
): SearchExecutor {
	const {
		includeExtensions,
		excludeDirs = DEFAULT_EXCLUDE_DIRS,
		maxResults = 100,
		maxMatchesPerFile = 10,
		contextLines = 2,
		maxDepth = 20,
		rgPath,
		rgTimeoutMs = 20_000,
	} = options;
	const excludeDirsSet = new Set(excludeDirs);
	const includeExtensionsSet = includeExtensions
		? new Set(includeExtensions.map((extension) => extension.toLowerCase()))
		: undefined;

	const resolveRipgrep = createRipgrepResolver(rgPath);

	const scanFiles = async (
		regex: RegExp,
		scope: ResolvedScope,
		perFileLimit: number,
		signal: AbortSignal | undefined,
	): Promise<SearchOutcome> => {
		const matches: SearchMatch[] = [];
		const cappedFiles: string[] = [];
		let filesSearched = 0;

		const candidates = scope.file
			? [""]
			: Array.from(await getFileIndex(scope.root)).filter(
					(relativePath) =>
						shouldIncludeFile(
							relativePath,
							excludeDirsSet,
							includeExtensionsSet,
							maxDepth,
						) &&
						(!scope.glob ||
							scope.glob(`${scope.displayPrefix}${relativePath}`)),
				);

		for (const relativePath of candidates) {
			if (signal?.aborted) {
				throw new Error("Search operation aborted");
			}
			if (matches.length >= maxResults) break;

			const filePath = scope.file ?? path.join(scope.root, relativePath);
			const displayPath = `${scope.displayPrefix}${relativePath}`;
			let content: string;
			try {
				const stats = await fs.stat(filePath);
				if (stats.size > MAX_FALLBACK_FILE_BYTES) {
					continue;
				}
				content = await fs.readFile(filePath, "utf-8");
			} catch {
				continue;
			}
			// A NUL this early means a binary file with an unlisted extension.
			if (content.slice(0, 8192).includes("\u0000")) {
				continue;
			}

			filesSearched++;
			const lines = content.split(/\r\n|\n/);
			let countInFile = 0;

			for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
				const line = lines[lineIdx];
				regex.lastIndex = 0; // Reset regex state
				const match = regex.exec(line);
				if (match === null) {
					continue;
				}
				countInFile++;
				if (countInFile > perFileLimit) {
					cappedFiles.push(displayPath);
					break;
				}
				if (matches.length >= maxResults) {
					break;
				}

				const contextStart = Math.max(0, lineIdx - contextLines);
				const contextEnd = Math.min(lines.length - 1, lineIdx + contextLines);
				const context: string[] = [];
				for (let i = contextStart; i <= contextEnd; i++) {
					context.push(contextLine(i === lineIdx ? ">" : " ", i + 1, lines[i]));
				}
				matches.push({
					file: displayPath,
					line: lineIdx + 1,
					column: match.index + 1,
					match: match[0],
					context,
				});
			}
		}

		return { matches, cappedFiles, filesSearched };
	};

	return async (
		query: string,
		cwd: string,
		context: AgentToolContext,
		searchScope?: SearchScope,
	): Promise<string> => {
		// Check for abort before starting
		if (context.signal?.aborted) {
			throw new Error("Search operation aborted");
		}

		const scope = await resolveScope(cwd, searchScope);
		const perFileLimit = scope.file ? maxResults : maxMatchesPerFile;

		// Try ripgrep first if available
		let outcome: SearchOutcome | null = null;
		const command = await resolveRipgrep();
		if (command) {
			outcome = await searchWithRipgrep({
				command,
				query,
				cwd,
				target: scope.target,
				glob: scope.rawGlob,
				maxResults,
				maxMatchesPerFile: perFileLimit,
				contextLines,
				timeoutMs: rgTimeoutMs,
				abortSignal: context.signal,
			});
		}

		if (!outcome) {
			// Fallback to manual regex search
			let regex: RegExp;
			try {
				regex = new RegExp(query, "gim");
			} catch (error) {
				throw new Error(
					`Invalid regex pattern: ${query}. ${error instanceof Error ? error.message : ""}`,
				);
			}
			outcome = await scanFiles(regex, scope, perFileLimit, context.signal);
		}

		return capSearchOutput(
			formatOutcome(outcome, query, searchScope, maxResults, perFileLimit),
		);
	};
}

function formatOutcome(
	outcome: SearchOutcome,
	query: string,
	scope: SearchScope | undefined,
	maxResults: number,
	perFileLimit: number,
): string {
	const { matches, cappedFiles, filesSearched } = outcome;
	const where = [
		scope?.path?.trim() ? ` in ${scope.path.trim()}` : "",
		scope?.glob?.trim() ? ` (files matching ${scope.glob.trim()})` : "",
	].join("");
	const searched =
		filesSearched === undefined ? [] : [`Searched ${filesSearched} files.`];

	if (matches.length === 0) {
		return [`No results found for pattern: ${query}${where}`, ...searched].join(
			"\n",
		);
	}

	const resultLines: string[] = [
		`Found ${matches.length} result${matches.length === 1 ? "" : "s"} for pattern: ${query}${where}`,
		...searched,
		"",
	];

	for (const match of matches) {
		resultLines.push(`${match.file}:${match.line}:${match.column}`);
		resultLines.push(...match.context);
		resultLines.push("");
	}

	if (matches.length >= maxResults) {
		resultLines.push(
			`(Showing first ${maxResults} results. Refine your search for more specific results.)`,
		);
	}
	if (cappedFiles.length > 0) {
		const listed = cappedFiles.slice(0, 20).join(", ");
		const rest = cappedFiles.length - 20;
		resultLines.push(
			`(Only the first ${perFileLimit} matches per file are shown. More exist in: ${listed}${rest > 0 ? ` and ${rest} more files` : ""}. Set path to one of these files to see all of its matches.)`,
		);
	}

	return resultLines.join("\n");
}

/**
 * Middle-truncate oversized search output. Matches with long context lines
 * can blow past the per-query cap even within the maxResults bound; the
 * head (earliest matches plus the result count) and tail (the refine hint)
 * are preserved and the middle is elided with a notice teaching the model
 * to narrow the pattern instead of retrying.
 */
function capSearchOutput(text: string): string {
	if (text.length <= MAX_SEARCH_OUTPUT_CHARS) {
		return text;
	}
	const headLimit = Math.ceil(MAX_SEARCH_OUTPUT_CHARS / 2);
	const tailLimit = Math.max(1, MAX_SEARCH_OUTPUT_CHARS - headLimit);
	return (
		`${text.slice(0, headLimit)}\n` +
		`[... search output truncated: ${text.length} chars total. ` +
		"Narrow the pattern or scope to view the elided matches ...]\n" +
		text.slice(-tailLimit)
	);
}
