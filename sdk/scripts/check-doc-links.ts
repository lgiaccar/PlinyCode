#!/usr/bin/env bun

/**
 * Fails when a tracked markdown file links to a repo path that does not exist,
 * or when a Claude Code skill (`.claude/skills/<name>/SKILL.md`) has invalid
 * frontmatter.
 *
 * Checks relative targets of inline links, images and reference definitions,
 * outside code blocks and code spans. External URLs and `#anchor`-only links
 * are skipped, and anchors are not checked. Only files tracked by git are
 * read, so node_modules and local worktrees are never scanned.
 *
 * A skill needs a `name` equal to its directory name (lowercase words joined
 * by hyphens, at most 64 characters) and a non-empty `description` of at most
 * 1024 characters, which is what decides when the skill is used.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "..", "..");

const INLINE_LINK =
	/!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SKILL_FILE = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

type BrokenLink = { file: string; line: number; target: string };

function listTrackedMarkdown(): string[] {
	const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"], {
		cwd: root,
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().split("\0").filter(Boolean);
}

function resolveTarget(file: string, rawTarget: string): string | undefined {
	let target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
	if (target === "" || target.startsWith("#") || target.startsWith("//")) {
		return undefined;
	}
	if (HAS_SCHEME.test(target)) {
		return undefined;
	}
	target = target.replace(/[?#].*$/, "");
	try {
		target = decodeURIComponent(target);
	} catch {
		// Keep the raw target; a malformed escape is reported as missing.
	}
	return target.startsWith("/")
		? path.join(root, target)
		: path.join(root, path.dirname(file), target);
}

function findLinkTargets(line: string): string[] {
	const reference = REFERENCE_DEFINITION.exec(line);
	if (reference) {
		return [reference[1]];
	}
	const text = line.replace(CODE_SPAN, "");
	return [...text.matchAll(INLINE_LINK)].map((match) => match[1]);
}

async function checkFile(file: string): Promise<BrokenLink[]> {
	const lines = (await readFile(path.join(root, file), "utf8")).split(/\r?\n/);
	const broken: BrokenLink[] = [];
	let fence: string | undefined;

	lines.forEach((line, index) => {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (fence === undefined) {
				fence = marker;
			} else if (marker[0] === fence[0] && marker.length >= fence.length) {
				fence = undefined;
			}
			return;
		}
		if (fence !== undefined) {
			return;
		}
		for (const target of findLinkTargets(line)) {
			const resolved = resolveTarget(file, target);
			if (resolved !== undefined && !existsSync(resolved)) {
				broken.push({ file, line: index + 1, target });
			}
		}
	});

	return broken;
}

async function checkSkill(
	file: string,
	directoryName: string,
): Promise<string[]> {
	const text = await readFile(path.join(root, file), "utf8");
	const frontmatter = FRONTMATTER.exec(text);
	if (!frontmatter) {
		return ["missing YAML frontmatter between --- lines at the top"];
	}
	let data: unknown;
	try {
		data = Bun.YAML.parse(frontmatter[1]);
	} catch (error) {
		return [`frontmatter is not valid YAML: ${(error as Error).message}`];
	}
	const fields = (data ?? {}) as Record<string, unknown>;
	const problems: string[] = [];

	const { name, description } = fields;
	if (typeof name !== "string" || name === "") {
		problems.push("missing `name`");
	} else if (name !== directoryName) {
		problems.push(
			`\`name\` is "${name}" but the directory is "${directoryName}"`,
		);
	} else if (!SKILL_NAME.test(name) || name.length > MAX_SKILL_NAME_LENGTH) {
		problems.push(
			`\`name\` must be lowercase words joined by hyphens, at most ${MAX_SKILL_NAME_LENGTH} characters`,
		);
	}
	if (typeof description !== "string" || description.trim() === "") {
		problems.push("missing `description`");
	} else if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
		problems.push(
			`\`description\` is ${description.length} characters; the limit is ${MAX_SKILL_DESCRIPTION_LENGTH}`,
		);
	}
	return problems;
}

async function main(): Promise<void> {
	const files = listTrackedMarkdown();
	const broken = (await Promise.all(files.map(checkFile))).flat();
	const skills = files.flatMap((file) => {
		const match = SKILL_FILE.exec(file);
		return match ? [{ file, directoryName: match[1] }] : [];
	});
	const skillProblems = (
		await Promise.all(
			skills.map(async ({ file, directoryName }) =>
				(
					await checkSkill(file, directoryName)
				).map((problem) => `${file}: ${problem}`),
			),
		)
	).flat();

	for (const { file, line, target } of broken) {
		console.error(`${file}:${line}: broken link to ${target}`);
	}
	for (const problem of skillProblems) {
		console.error(problem);
	}
	if (broken.length > 0 || skillProblems.length > 0) {
		console.error(
			`\n${broken.length} broken link(s) in ${files.length} markdown files; ` +
				`${skillProblems.length} problem(s) in ${skills.length} skills.`,
		);
		process.exit(1);
	}
	console.log(
		`All relative links resolve in ${files.length} markdown files; ` +
			`all ${skills.length} skills have valid frontmatter.`,
	);
}

await main();
