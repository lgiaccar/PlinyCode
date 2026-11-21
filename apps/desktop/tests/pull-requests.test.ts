import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultPermissions, type Project, type Task } from "../src/contracts";
import { git, prepareWorktree } from "../src/git";
import { type PrRepository, prRepositorySchema } from "../src/pr-contracts";
import {
	PullRequestProvider,
	previewPullRequest,
	publishPullRequest,
	remoteMatches,
} from "../src/pull-requests";

const request = {
	title: "Fixture PR",
	body: "Details\n\nValidation",
	target: "main",
	commit: true,
	draft: true,
	retryUncertain: false,
};
const github: PrRepository = {
	provider: "github",
	apiUrl: "https://api.github.com",
	owner: "owner",
	repository: "repo",
	apiVersion: "7.0",
};
test("GitHub and Azure cloud/Server use correct URLs, authentication, payloads and existing PR queries", async () => {
	for (const config of [
		github,
		{
			...github,
			provider: "azure" as const,
			apiUrl: "https://dev.azure.com/org",
			owner: "My Project",
		},
		{
			...github,
			provider: "azure" as const,
			apiUrl: "https://server.example/tfs/Collection",
			owner: "My Project",
			apiVersion: "6.0" as const,
		},
	]) {
		const calls: { url: URL; options: RequestInit }[] = [];
		const azure = config.provider === "azure";
		const item = azure
			? { pullRequestId: 42 }
			: { number: 42, html_url: "https://github.com/owner/repo/pull/42" };
		const provider = new PullRequestProvider(config, "fixture-token", (async (
			url: URL,
			options: RequestInit,
		) => {
			calls.push({ url, options });
			return Response.json(
				options.method === "POST" ? item : azure ? { value: [item] } : [item],
			);
		}) as unknown as typeof fetch);
		expect((await provider.find("feature/slash", "main"))?.number).toBe(42);
		expect((await provider.create("feature/slash", request)).number).toBe(42);
		expect(
			calls[0].url.searchParams.get(
				azure ? "searchCriteria.sourceRefName" : "head",
			),
		).toBe(azure ? "refs/heads/feature/slash" : "owner:feature/slash");
		expect(calls[1].options.redirect).toBe("error");
		expect(new Headers(calls[1].options.headers).get("authorization")).toBe(
			azure
				? `Basic ${Buffer.from(":fixture-token").toString("base64")}`
				: "Bearer fixture-token",
		);
		const payload = JSON.parse(calls[1].options.body as string);
		expect(payload[azure ? "description" : "body"]).toBe(request.body);
		expect(payload[azure ? "isDraft" : "draft"]).toBe(true);
		if (azure) {
			expect(calls[1].url.searchParams.get("api-version")).toBe(
				config.apiVersion,
			);
			expect(calls[1].url.pathname).toContain(
				"/My%20Project/_apis/git/repositories/repo/pullrequests",
			);
		}
	}
});
test("provider errors do not echo tokens, reject redirects and invalid settings, and match push destinations", async () => {
	const provider = new PullRequestProvider(
		github,
		"secret",
		(async () =>
			new Response("secret", { status: 401 })) as unknown as typeof fetch,
	);
	await expect(provider.find("branch", "main")).rejects.toThrow("HTTP 401");
	const invalid = new PullRequestProvider(
		github,
		"secret",
		(async () => new Response("secret")) as unknown as typeof fetch,
	);
	await expect(invalid.find("branch", "main")).rejects.toThrow("invalid JSON");
	expect(
		prRepositorySchema.safeParse({
			...github,
			apiUrl: "https://user:token@host",
		}).success,
	).toBe(false);
	expect(
		prRepositorySchema.safeParse({ ...github, owner: "../x" }).success,
	).toBe(false);
	expect(remoteMatches("git@github.com:owner/repo.git", github)).toBe(true);
	expect(remoteMatches("https://github.com/other/repo", github)).toBe(false);
	expect(
		remoteMatches("https://user:secret@github.com/owner/repo", github),
	).toBe(false);
	expect(
		remoteMatches("git@ssh.dev.azure.com:v3/org/project/repo", {
			...github,
			provider: "azure",
			apiUrl: "https://dev.azure.com/org",
			owner: "project",
		}),
	).toBe(true);
	expect(
		remoteMatches("https://server/tfs/Collection/project/_git/repo", {
			...github,
			provider: "azure",
			apiUrl: "https://server/tfs/Collection",
			owner: "project",
		}),
	).toBe(true);
});
test("PR refresh reports merged and closed requests, and unexpected web links are rejected", async () => {
	for (const [remote, expected] of [
		[{ state: "closed", merged: true }, "merged"],
		[{ state: "closed", merged: false }, "closed"],
	] as const) {
		const provider = new PullRequestProvider(
			github,
			"fixture-token",
			(async () =>
				Response.json({
					number: 3,
					html_url: "https://github.com/owner/repo/pull/3",
					...remote,
				})) as unknown as typeof fetch,
		);
		expect((await provider.get(3, "main")).status).toBe(expected);
	}
	const provider = new PullRequestProvider(github, "fixture-token", (async () =>
		Response.json({
			number: 3,
			html_url: "https://unexpected.invalid/pull/3",
		})) as unknown as typeof fetch);
	await expect(provider.get(3, "main")).rejects.toThrow("invalid web link");
});
test("real Git publishes only the task worktree, retains source dirt, and reconciles uncertain creates without duplication", async () => {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const root = await mkdtemp(join(scratch, "desktop-pr-"));
	try {
		const origin = join(root, "origin.git"),
			source = join(root, "source");
		await mkdir(source);
		await git(root, ["init", "--bare", "--initial-branch=main", origin]);
		await git(source, ["init", "--initial-branch=main"]);
		await git(source, ["config", "user.name", "Fixture"]);
		await git(source, ["config", "user.email", "fixture@example.invalid"]);
		await writeFile(join(source, "file.txt"), "original");
		await git(source, ["add", "."]);
		await git(source, ["commit", "-m", "initial"]);
		await git(source, ["remote", "add", "origin", origin]);
		await git(source, ["push", "origin", "main"]);
		const project: Project = {
			id: crypto.randomUUID(),
			name: "fixture",
			path: source,
			git: true,
			base: "main",
			target: "",
			remote: "origin",
		};
		const task: Task = {
			id: crypto.randomUUID(),
			projectId: project.id,
			title: "fixture",
			model: "pliny/auto-free",
			permissions: defaultPermissions,
			status: "completed",
			messages: [],
			createdAt: 0,
			updatedAt: 0,
			worktree: true,
		};
		Object.assign(
			task,
			await prepareWorktree(
				project,
				task,
				root,
				false,
				new AbortController().signal,
			),
		);
		await writeFile(join(source, "file.txt"), "source dirt");
		await writeFile(join(task.cwd as string, "file.txt"), "task change");
		// Only the displayed remote is substituted; all Git mutations use the local bare fixture.
		const runGit: typeof git = (cwd, args, signal) =>
			args[0] === "remote" && args[1] === "get-url"
				? Promise.resolve("https://github.com/owner/repo.git")
				: git(cwd, args, signal);
		const preview = await previewPullRequest(task, project);
		expect(preview.target).toBe("main");
		expect(preview.changes).toContain("file.txt");
		let creates = 0;
		let visible = false;
		const provider = new PullRequestProvider(github, "fixture", (async (
			_url: URL,
			options: RequestInit,
		) => {
			if (options.method === "POST") {
				creates++;
				throw new Error("response lost");
			}
			return Response.json(
				creates && visible
					? [{ number: 7, html_url: "https://github.com/owner/repo/pull/7" }]
					: [],
			);
		}) as unknown as typeof fetch);
		await expect(
			publishPullRequest(
				task,
				project,
				{ ...request, commit: false },
				provider,
				() => {},
				undefined,
				runGit,
			),
		).rejects.toThrow("Publishing failed");
		expect(creates).toBe(0);
		await expect(
			publishPullRequest(
				task,
				project,
				request,
				provider,
				() => {},
				undefined,
				runGit,
			),
		).rejects.toThrow("uncertain");
		expect(task.pullRequest?.status).toBe("uncertain");
		await expect(
			publishPullRequest(
				task,
				project,
				request,
				provider,
				() => {},
				undefined,
				runGit,
			),
		).rejects.toThrow("previous create may have succeeded");
		expect(creates).toBe(1);
		visible = true;
		expect(await git(origin, ["show", task.branch + ":file.txt"])).toBe(
			"task change",
		);
		expect(await readFile(join(source, "file.txt"), "utf8")).toBe(
			"source dirt",
		);
		expect(await git(source, ["branch", "--show-current"])).toBe("main");
		expect(
			(
				await publishPullRequest(
					task,
					project,
					request,
					provider,
					() => {},
					undefined,
					runGit,
				)
			).number,
		).toBe(7);
		expect(creates).toBe(1);
		await git(task.cwd as string, ["checkout", "-b", "other"]);
		await expect(previewPullRequest(task, project)).rejects.toThrow(
			"branch changed",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
