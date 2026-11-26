import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Project, Task } from "./contracts";

export function git(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((accept, reject) =>
		execFile(
			"git",
			args,
			{
				cwd,
				windowsHide: true,
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
				signal,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout, stderr) =>
				error
					? reject(new Error(stderr.trim() || error.message))
					: accept(stdout.trim()),
		),
	);
}
export async function isGit(path: string) {
	return (
		(await git(path, ["rev-parse", "--is-inside-work-tree"]).catch(
			() => "",
		)) === "true"
	);
}
export function overlaps(a: string, b: string) {
	const normalize = (p: string) => {
		const full = resolve(p);
		return process.platform === "win32" ? full.toLowerCase() : full;
	};
	const left = normalize(a),
		right = normalize(b);
	return (
		left === right ||
		left.startsWith(right.endsWith(sep) ? right : right + sep) ||
		right.startsWith(left.endsWith(sep) ? left : left + sep)
	);
}
const preparing = new Map<string, Promise<unknown>>();
export async function prepareWorktree(
	project: Project,
	task: Task,
	data: string,
	cached: boolean,
	signal: AbortSignal,
) {
	const root = await git(
		project.path,
		["rev-parse", "--show-toplevel"],
		signal,
	);
	const previous = preparing.get(root) ?? Promise.resolve();
	const operation = previous
		.catch(() => {})
		.then(async () => {
			signal.throwIfAborted();
			let base = project.base;
			const discoverDefault = !base && !cached;
			let commit: string;
			if (project.worktreeSource === "local") {
				if (!base)
					base = await git(
						root,
						["symbolic-ref", "--quiet", "--short", "HEAD"],
						signal,
					).catch(() => "");
				signal.throwIfAborted();
				if (!base)
					throw new Error(
						"Select a local worktree base branch in project settings, or check out a local branch first.",
					);
				await git(root, ["check-ref-format", "--branch", base], signal);
				try {
					commit = await git(
						root,
						["rev-parse", "--verify", `refs/heads/${base}^{commit}`],
						signal,
					);
				} catch {
					signal.throwIfAborted();
					throw new Error(
						`Local branch "${base}" has no commit. Make an initial commit or select an existing local branch in project settings.`,
					);
				}
			} else {
				const remotes = (await git(root, ["remote"], signal)).split(/\r?\n/);
				if (!remotes.includes(project.remote))
					throw new Error(
						`Git remote "${project.remote}" is not configured for this project. Choose Local branch in project settings to work locally, or configure a remote.`,
					);
				if (!base) {
					if (cached)
						base = (
							await git(
								root,
								["symbolic-ref", `refs/remotes/${project.remote}/HEAD`],
								signal,
							)
						).replace(`refs/remotes/${project.remote}/`, "");
					else {
						const head = await git(
							root,
							["ls-remote", "--symref", project.remote, "HEAD"],
							signal,
						);
						base =
							/^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(head)?.[1]?.trim() ?? "";
					}
				}
				if (!base)
					throw new Error(
						"Could not discover the remote default branch. Set a worktree base in project settings.",
					);
				await git(root, ["check-ref-format", "--branch", base], signal);
				if (!cached)
					await git(
						root,
						[
							"fetch",
							"--no-tags",
							project.remote,
							`+refs/heads/${base}:refs/remotes/${project.remote}/${base}`,
						],
						signal,
					);
				commit = await git(
					root,
					[
						"rev-parse",
						"--verify",
						`refs/remotes/${project.remote}/${base}^{commit}`,
					],
					signal,
				);
				if (discoverDefault)
					await git(
						root,
						[
							"symbolic-ref",
							`refs/remotes/${project.remote}/HEAD`,
							`refs/remotes/${project.remote}/${base}`,
						],
						signal,
					);
			}
			const username =
				userInfo()
					.username.toLowerCase()
					.replace(/[^a-z0-9_-]/g, "-") || "plinycode";
			const branch = `${username}/desktop-${task.id.slice(0, 8)}`;
			const folder = join(
				data,
				"worktrees",
				createHash("sha256").update(root).digest("hex").slice(0, 12),
				task.id.slice(0, 8),
			);
			await mkdir(resolve(folder, ".."), { recursive: true });
			await git(
				root,
				["worktree", "add", "-b", branch, folder, commit],
				signal,
			);
			return {
				cwd: await realpath(folder),
				branch,
				baseCommit: commit,
				baseBranch: base,
			};
		});
	preparing.set(root, operation);
	try {
		return await operation;
	} finally {
		if (preparing.get(root) === operation) preparing.delete(root);
	}
}

export async function taskDiff(task: Task) {
	if (!task.cwd) return "No working folder has been prepared.";
	if (!(await isGit(task.cwd))) return "Diff review requires a Git repository.";
	const diff = await git(task.cwd, [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		task.baseCommit ?? "HEAD",
		"--",
	]);
	const untracked = await git(task.cwd, [
		"ls-files",
		"--others",
		"--exclude-standard",
	]);
	return `${diff || "No tracked changes."}${untracked ? `\n\nNew untracked files (open the folder to inspect):\n${untracked}` : ""}`;
}
