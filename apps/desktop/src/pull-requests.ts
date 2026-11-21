import type { Project, Task } from "./contracts";
import { git } from "./git";
import {
	type PrCreate,
	type PrRepository,
	type PullRequest,
	prCreateSchema,
	prRepositorySchema,
} from "./pr-contracts";

type Json = Record<string, unknown>;
export class PullRequestProvider {
	readonly repository: PrRepository;
	constructor(
		repository: PrRepository,
		private token: string,
		private transport: typeof fetch = fetch,
	) {
		this.repository = prRepositorySchema.parse(repository);
		if (!token.trim())
			throw new Error(
				"Save a provider access token in project settings first.",
			);
	}
	private endpoint() {
		const config = this.repository;
		const base = config.apiUrl.replace(/\/+$/, "");
		const path =
			config.provider === "github"
				? `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/pulls`
				: `${encodeURIComponent(config.owner)}/_apis/git/repositories/${encodeURIComponent(config.repository)}/pullrequests`;
		return new URL(`${base}/${path}`);
	}
	private async call(
		url: URL,
		signal?: AbortSignal,
		body?: unknown,
	): Promise<unknown> {
		const azure = this.repository.provider === "azure";
		if (azure) url.searchParams.set("api-version", this.repository.apiVersion);
		let response: Response;
		try {
			response = await this.transport(url, {
				method: body ? "POST" : "GET",
				redirect: "error",
				headers: {
					Authorization: azure
						? `Basic ${Buffer.from(`:${this.token}`).toString("base64")}`
						: `Bearer ${this.token}`,
					Accept: "application/json",
					"Content-Type": "application/json",
					"User-Agent": "PlinyCode-Desktop",
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
					: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new Error(
				"PR provider request interrupted or unreachable. Check connection and authentication; an interrupted create may have succeeded.",
			);
		}
		if (!response.ok)
			throw new Error(
				`PR provider returned HTTP ${response.status}. Check token scope, repository settings and branch names.`,
			);
		const text = await response.text();
		if (text.length > 2_000_000)
			throw new Error("PR provider response was too large.");
		try {
			return JSON.parse(text);
		} catch {
			throw new Error("PR provider returned invalid JSON.");
		}
	}
	private result(raw: unknown, target: string): PullRequest {
		const value = raw as Json;
		const azure = this.repository.provider === "azure";
		const number = Number(azure ? value.pullRequestId : value.number);
		if (!Number.isSafeInteger(number) || number <= 0)
			throw new Error("PR provider returned an invalid PR identifier.");
		const url = azure
			? `${this.repository.apiUrl.replace(/\/+$/, "")}/${encodeURIComponent(this.repository.owner)}/_git/${encodeURIComponent(this.repository.repository)}/pullrequest/${number}`
			: String(value.html_url);
		const parsed = new URL(url);
		const api = new URL(this.repository.apiUrl);
		const expectedHost =
			api.hostname === "api.github.com" ? "github.com" : api.host;
		if (
			!["http:", "https:"].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			parsed.host !== expectedHost ||
			url.includes(this.token)
		)
			throw new Error("PR provider returned an invalid web link.");
		const status = azure
			? value.status === "completed"
				? "merged"
				: value.status === "abandoned"
					? "closed"
					: "open"
			: value.merged === true
				? "merged"
				: value.state === "closed"
					? "closed"
					: "open";
		return { status, number, url, target };
	}
	async get(number: number, target: string, signal?: AbortSignal) {
		if (!Number.isSafeInteger(number) || number <= 0)
			throw new Error("Invalid PR identifier.");
		const url = this.endpoint();
		url.pathname += `/${number}`;
		return this.result(await this.call(url, signal), target);
	}
	async find(branch: string, target: string, signal?: AbortSignal) {
		const url = this.endpoint();
		const azure = this.repository.provider === "azure";
		if (azure) {
			url.searchParams.set(
				"searchCriteria.sourceRefName",
				`refs/heads/${branch}`,
			);
			url.searchParams.set(
				"searchCriteria.targetRefName",
				`refs/heads/${target}`,
			);
			url.searchParams.set("searchCriteria.status", "active");
		} else {
			url.searchParams.set("head", `${this.repository.owner}:${branch}`);
			url.searchParams.set("base", target);
			url.searchParams.set("state", "open");
		}
		const response = await this.call(url, signal);
		const rows = azure ? (response as Json).value : response;
		if (!Array.isArray(rows))
			throw new Error("PR provider returned an invalid list.");
		return rows.length ? this.result(rows[0], target) : undefined;
	}
	async create(branch: string, input: PrCreate, signal?: AbortSignal) {
		const payload =
			this.repository.provider === "github"
				? {
						title: input.title,
						body: input.body,
						head: branch,
						base: input.target,
						draft: input.draft,
					}
				: {
						title: input.title,
						description: input.body,
						sourceRefName: `refs/heads/${branch}`,
						targetRefName: `refs/heads/${input.target}`,
						isDraft: input.draft,
					};
		return this.result(
			await this.call(this.endpoint(), signal, payload),
			input.target,
		);
	}
}

export async function previewPullRequest(
	task: Task,
	project: Project,
	signal?: AbortSignal,
	runGit = git,
) {
	if (
		!task.worktree ||
		!task.cwd ||
		!task.branch ||
		!task.baseBranch ||
		!task.baseCommit
	)
		throw new Error(
			"Start an isolated Git worktree task before creating a PR.",
		);
	if (
		(await runGit(task.cwd, ["branch", "--show-current"], signal)) !==
		task.branch
	)
		throw new Error(
			"The worktree branch changed. Restore the task branch before publishing.",
		);
	const target = project.target || task.baseBranch;
	await runGit(task.cwd, ["check-ref-format", "--branch", target], signal);
	return {
		branch: task.branch,
		target,
		remote: await runGit(
			task.cwd,
			["remote", "get-url", "--push", project.remote],
			signal,
		),
		changes: await runGit(task.cwd, ["status", "--short"], signal),
		commits: await runGit(
			task.cwd,
			["log", "--oneline", `${task.baseCommit}..HEAD`],
			signal,
		),
	};
}

export function remoteMatches(remote: string, config: PrRepository) {
	let url: URL;
	try {
		url = new URL(
			remote.includes("://")
				? remote
				: remote.replace(/^([^@]+@)?([^:]+):/, "ssh://$1$2/"),
		);
	} catch {
		return false;
	}
	if (url.password || (url.protocol !== "ssh:" && url.username)) return false;
	const path = decodeURIComponent(url.pathname)
		.replace(/\.git$/, "")
		.replace(/^\/+|\/+$/g, "");
	const api = new URL(config.apiUrl);
	if (config.provider === "github")
		return (
			url.hostname ===
				(api.hostname === "api.github.com" ? "github.com" : api.hostname) &&
			path.toLowerCase() ===
				`${config.owner}/${config.repository}`.toLowerCase()
		);
	if (url.hostname === "ssh.dev.azure.com" && api.hostname === "dev.azure.com")
		return (
			path.toLowerCase() ===
			`v3/${api.pathname.replace(/^\/+|\/+$/g, "")}/${config.owner}/${config.repository}`.toLowerCase()
		);
	return (
		url.host === api.host &&
		path.toLowerCase() ===
			`${api.pathname.replace(/^\/+|\/+$/g, "")}/${config.owner}/_git/${config.repository}`
				.replace(/^\//, "")
				.toLowerCase()
	);
}

/** Callers hold the task's write lease until this operation settles. No automatic retry. */
export async function publishPullRequest(
	task: Task,
	project: Project,
	input: PrCreate,
	provider: PullRequestProvider,
	save: () => void,
	signal?: AbortSignal,
	runGit = git,
) {
	const request = prCreateSchema.parse(input);
	const preview = await previewPullRequest(task, project, signal, runGit);
	await runGit(
		task.cwd as string,
		["check-ref-format", "--branch", request.target],
		signal,
	);
	if (preview.branch === request.target)
		throw new Error("The PR source and target must differ.");
	if (!remoteMatches(preview.remote, provider.repository))
		throw new Error(
			"The push remote does not match the configured PR repository. Correct project settings first.",
		);
	const existing = await provider.find(preview.branch, request.target, signal);
	if (existing) {
		task.pullRequest = existing;
		save();
		return existing;
	}
	if (
		["creating", "uncertain"].includes(task.pullRequest?.status ?? "") &&
		!request.retryUncertain
	)
		throw new Error(
			"The previous create may have succeeded. Refresh PR status and inspect the provider before explicitly retrying.",
		);
	let creating = false;
	try {
		task.pullRequest = { status: "publishing", target: request.target };
		save();
		if (preview.changes) {
			if (!request.commit)
				throw new Error(
					"The worktree has uncommitted changes. Commit them first or select Commit all task changes.",
				);
			await runGit(task.cwd as string, ["add", "--all", "--", "."], signal);
			await runGit(task.cwd as string, ["commit", "-m", request.title], signal);
		}
		if (
			!(await runGit(
				task.cwd as string,
				["rev-list", `${task.baseCommit}..HEAD`],
				signal,
			))
		)
			throw new Error("There are no task commits to publish.");
		await runGit(
			task.cwd as string,
			["push", "--", project.remote, `HEAD:refs/heads/${preview.branch}`],
			signal,
		);
		task.pullRequest.status = "creating";
		save();
		creating = true;
		const result = await provider.create(preview.branch, request, signal);
		task.pullRequest = result;
		save();
		return result;
	} catch {
		// Raw git errors can contain remote credentials. Do not persist them.
		task.pullRequest = {
			status: creating ? "uncertain" : "failed",
			target: request.target,
			error: creating
				? "Creation outcome is uncertain. Refresh before retrying."
				: "Publishing failed. Check Git authentication, identity, branch protection and uncommitted changes.",
		};
		save();
		throw new Error(task.pullRequest.error);
	}
}
