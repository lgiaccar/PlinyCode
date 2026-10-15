import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Guides written for coding agents below the workspace root: `AGENTS.md` and
 * `CLAUDE.md` files in sub-directories (`apps/vscode/AGENTS.md`), and a
 * `CLAUDE.md` at the root. Only the root `AGENTS.md` used to be read, so a
 * repository's per-package guides never reached the model.
 *
 * They are rules listed by path, never inlined: a nested guide applies to
 * files under its own directory, and a root `CLAUDE.md` usually repeats the
 * root `AGENTS.md`. The model reads one with `read_files` when its scope
 * applies, as it does for other scoped rules (rules.ts).
 */
const GUIDE_FILE_NAMES = new Set(["agents.md", "claude.md"]);

/** How far below the root a guide is looked for. */
export const MAX_NESTED_GUIDE_DEPTH = 3;
/** Most guides listed; a monorepo with more keeps the shallowest. */
export const MAX_NESTED_GUIDES = 30;
/** Directories visited at most, so a huge tree costs a bounded walk. */
const MAX_DIRECTORIES_VISITED = 2_000;

const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	"coverage",
	"bin",
	"obj",
	"__pycache__",
	"venv",
]);

function isSkippedDirectory(name: string): boolean {
	return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name.toLowerCase());
}

/**
 * The guide files under `workspacePath`, breadth first (shallowest first),
 * without the root `AGENTS.md`, which the rules search paths already read.
 */
export function discoverNestedGuideFiles(
	workspacePath: string,
	options: { maxDepth?: number; maxFiles?: number } = {},
): string[] {
	const maxDepth = options.maxDepth ?? MAX_NESTED_GUIDE_DEPTH;
	const maxFiles = options.maxFiles ?? MAX_NESTED_GUIDES;
	const root = resolve(workspacePath);
	const found: string[] = [];
	let queue: Array<{ path: string; depth: number }> = [
		{ path: root, depth: 0 },
	];
	let visited = 0;
	while (queue.length > 0 && found.length < maxFiles) {
		const next: Array<{ path: string; depth: number }> = [];
		for (const directory of queue) {
			if (visited++ >= MAX_DIRECTORIES_VISITED || found.length >= maxFiles) {
				break;
			}
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(directory.path, { withFileTypes: true });
			} catch {
				continue;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (entry.isFile() && GUIDE_FILE_NAMES.has(entry.name.toLowerCase())) {
					const isRootAgents =
						directory.depth === 0 && entry.name.toLowerCase() === "agents.md";
					if (!isRootAgents && found.length < maxFiles) {
						found.push(join(directory.path, entry.name));
					}
				} else if (
					entry.isDirectory() &&
					directory.depth < maxDepth &&
					!isSkippedDirectory(entry.name)
				) {
					next.push({
						path: join(directory.path, entry.name),
						depth: directory.depth + 1,
					});
				}
			}
		}
		queue = next;
	}
	return found;
}

/** Whether `filePath` is a guide `discoverNestedGuideFiles` would list for `workspacePath`. */
export function isNestedGuideFile(
	filePath: string,
	workspacePath: string | undefined,
): boolean {
	if (
		!workspacePath ||
		!GUIDE_FILE_NAMES.has(basename(filePath).toLowerCase())
	) {
		return false;
	}
	const root = resolve(workspacePath);
	const file = resolve(filePath);
	if (!file.startsWith(`${root}${sep}`)) {
		return false;
	}
	return !(
		dirname(file) === root && basename(file).toLowerCase() === "agents.md"
	);
}

/**
 * The name and scope a guide is listed under: its path from the root, and
 * the files it applies to. A guide that sets its own scope keeps it.
 */
export function nestedGuideRule(
	filePath: string,
	workspacePath: string,
	frontmatter: Record<string, unknown>,
): { name: string; frontmatter: Record<string, unknown> } {
	const relativePath = relative(resolve(workspacePath), resolve(filePath))
		.split(sep)
		.join("/");
	const hasScope =
		frontmatter.paths !== undefined ||
		frontmatter.globs !== undefined ||
		frontmatter.applyTo !== undefined ||
		frontmatter.alwaysApply !== undefined;
	if (hasScope) {
		return { name: relativePath, frontmatter };
	}
	const directory = relativePath.includes("/")
		? relativePath.slice(0, relativePath.lastIndexOf("/"))
		: "";
	return {
		name: relativePath,
		frontmatter: directory
			? { ...frontmatter, paths: [`${directory}/**`] }
			: {
					...frontmatter,
					alwaysApply: false,
					description:
						"another agent's guide for this repository; read it when AGENTS.md and the rules above do not answer something",
				},
	};
}
