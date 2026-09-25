/** The provider-neutral PR and pipeline tools. Plain functions, so tests can call them without MCP. */
import { z } from "zod"
import { DevOpsError } from "./errors"
import { AzureDevOpsProvider } from "./providers/azdo"
import { GitHubProvider } from "./providers/github"
import { checkBody, type Provider, type PullRequest } from "./providers/types"
import { loadContext, pushProblem, type Remote, type RepoContext, remoteKey, remoteSlug } from "./repo"
import { checksTable, prSummary, runReport, runsTable, setSection } from "./report"

export const INSTRUCTIONS = `Pull requests and CI pipelines for the git repository you are working in. The same tools work
for GitHub (Actions) and Azure DevOps (Repos + Pipelines); the backend is chosen from the git remote.

- Call repo_context first to see the provider, current branch, default branch and any open PR.
- Pass \`workspace\` (the absolute path of the repository) on every call when you know it.
- PR descriptions are Markdown. Azure DevOps limits them to 4000 characters, GitHub to 65536.
- To keep generated content (e.g. CI results) current without overwriting hand-written text,
  use pr_update with a \`section\` name; only that section is replaced.
- Pipeline runs take minutes. Do not loop on pipeline_runs; check again later when asked.`

export type ProviderFactory = (remote: Remote) => Provider

export function defaultProviderFactory(): ProviderFactory {
	const cache = new Map<string, Provider>()
	return (remote) => {
		const key = remoteKey(remote)
		let provider = cache.get(key)
		if (!provider) {
			provider = remote.kind === "github" ? new GitHubProvider(remote) : new AzureDevOpsProvider(remote)
			cache.set(key, provider)
		}
		return provider
	}
}

const workspace = z
	.string()
	.optional()
	.describe("Absolute path of the git repository. Defaults to DEVOPS_MCP_WORKSPACE or the server's working directory.")
const prId = z.number().int().optional().describe("PR number/ID. Defaults to the open PR for the current branch.")

export interface ToolDefinition {
	name: string
	title: string
	description: string
	readOnly: boolean
	inputSchema: z.ZodRawShape
	run: (args: any) => Promise<string>
}

export function createTools(providerFor: ProviderFactory = defaultProviderFactory()): ToolDefinition[] {
	const open = async (ws?: string): Promise<[RepoContext, Provider]> => {
		const ctx = await loadContext(ws)
		return [ctx, providerFor(ctx.remote)]
	}

	const resolvePr = async (ctx: RepoContext, provider: Provider, id?: number): Promise<PullRequest> => {
		if (id !== undefined) {
			return provider.getPr(id)
		}
		if (!ctx.branch) {
			throw new DevOpsError("HEAD is detached, so there is no current branch; pass `pr_id`.")
		}
		const pr = await provider.findOpenPr(ctx.branch)
		if (!pr) {
			throw new DevOpsError(
				`No open pull request for branch '${ctx.branch}'. Pass \`pr_id\`, or create one with pr_create.`,
			)
		}
		return pr
	}

	return [
		{
			name: "repo_context",
			title: "Repository context",
			description:
				"Show the provider, repository, current and default branch, push state and the open PR for the current branch.",
			readOnly: true,
			inputSchema: { workspace },
			run: async ({ workspace: ws }) => {
				const [ctx, provider] = await open(ws)
				const lines = [
					`Provider: ${provider.kind}`,
					`Repository: ${remoteSlug(ctx.remote)} (${provider.repoUrl})`,
					`Local path: ${ctx.root}`,
					`Current branch: ${ctx.branch ?? "(detached HEAD)"}`,
					`Default branch: ${await provider.defaultBranch()}`,
					`Max PR description length: ${provider.maxBodyLength} characters`,
				]
				if (ctx.branch) {
					lines.push(`Push state: ${(await pushProblem(ctx, ctx.branch)) ?? "up to date with the remote"}`)
					const pr = await provider.findOpenPr(ctx.branch)
					lines.push(
						pr ? `Open PR for this branch: #${pr.id} ${pr.title} (${pr.url})` : "Open PR for this branch: none",
					)
				}
				return lines.join("\n")
			},
		},
		{
			name: "pr_create",
			title: "Create pull request",
			description: "Create a pull request from a pushed branch, with a Markdown description.",
			readOnly: false,
			inputSchema: {
				title: z.string(),
				body: z.string().describe("PR description in Markdown."),
				target_branch: z
					.string()
					.optional()
					.describe("Branch to merge into. Defaults to the repository's default branch."),
				source_branch: z.string().optional().describe("Branch with the changes. Defaults to the current branch."),
				draft: z.boolean().default(true).describe("Open the PR as a draft."),
				workspace,
			},
			run: async (args) => {
				const [ctx, provider] = await open(args.workspace)
				const source: string | undefined = args.source_branch || ctx.branch
				if (!source) {
					throw new DevOpsError("HEAD is detached; pass `source_branch`.")
				}
				checkBody(provider, args.body)
				const problem = await pushProblem(ctx, source)
				if (problem?.includes("not been pushed")) {
					throw new DevOpsError(problem)
				}
				const existing = await provider.findOpenPr(source)
				if (existing) {
					throw new DevOpsError(
						`Branch '${source}' already has open PR #${existing.id} (${existing.url}). Use pr_update to change it.`,
					)
				}
				const target: string = args.target_branch || (await provider.defaultBranch())
				if (target === source) {
					throw new DevOpsError(`Source and target are both '${source}'. Create a feature branch first.`)
				}
				const pr = await provider.createPr(args.title, args.body, source, target, args.draft ?? true)
				const note = problem ? `\n\nWarning: ${problem} The PR does not include them yet.` : ""
				return prSummary(pr, "Created pull request") + note
			},
		},
		{
			name: "pr_get",
			title: "Get pull request",
			description: "Show a pull request's title, state, branches and full Markdown description.",
			readOnly: true,
			inputSchema: { pr_id: prId, workspace },
			run: async (args) => {
				const [ctx, provider] = await open(args.workspace)
				const pr = await resolvePr(ctx, provider, args.pr_id)
				return `${prSummary(pr)}\n\n--- description ---\n${pr.body || "(empty)"}`
			},
		},
		{
			name: "pr_update",
			title: "Update pull request",
			description:
				"Update a pull request's title and/or Markdown description: the whole description, or only one named section.",
			readOnly: false,
			inputSchema: {
				pr_id: prId,
				title: z.string().optional().describe("New title. Omit to keep the current one."),
				body: z
					.string()
					.optional()
					.describe("Markdown. Replaces the whole description, or only the named section when `section` is set."),
				section: z
					.string()
					.optional()
					.describe(
						"Name of a generated section (letters, digits, '-', '_'), e.g. 'ci'. Only that section is replaced; it is appended if missing.",
					),
				workspace,
			},
			run: async (args) => {
				if (args.title === undefined && args.body === undefined) {
					throw new DevOpsError("Nothing to update: pass `title` and/or `body`.")
				}
				if (args.section !== undefined && args.body === undefined) {
					throw new DevOpsError("`section` needs `body` (the new section content).")
				}
				const [ctx, provider] = await open(args.workspace)
				const pr = await resolvePr(ctx, provider, args.pr_id)
				const body: string | undefined =
					args.section !== undefined ? setSection(pr.body, args.section, args.body) : args.body
				if (body !== undefined) {
					checkBody(provider, body)
				}
				return prSummary(await provider.updatePr(pr.id, args.title, body), "Updated pull request")
			},
		},
		{
			name: "pipeline_runs",
			title: "List pipeline runs",
			description:
				"List recent CI runs (GitHub Actions workflow runs or Azure Pipelines builds), newest first, as a Markdown table.",
			readOnly: true,
			inputSchema: {
				branch: z
					.string()
					.optional()
					.describe("Branch to list runs for. Defaults to the current branch; '*' lists all branches."),
				pr_id: z
					.number()
					.int()
					.optional()
					.describe("List the runs for this PR (its latest commit / PR build) instead of a branch."),
				limit: z.number().int().min(1).max(50).default(10),
				workspace,
			},
			run: async (args) => {
				const [ctx, provider] = await open(args.workspace)
				const pr = args.pr_id !== undefined ? await provider.getPr(args.pr_id) : undefined
				const target = args.branch === "*" ? undefined : args.branch || ctx.branch
				const runs = await provider.listRuns(target, pr, args.limit ?? 10)
				const scope = pr ? `PR #${pr.id}` : target ? `branch ${target}` : "all branches"
				return `Pipeline runs for ${scope} (${provider.kind}):\n\n${runsTable(runs)}`
			},
		},
		{
			name: "pipeline_report",
			title: "Pipeline run report",
			description:
				"Report one CI run as Markdown: job results, failed steps, their error messages and the log lines around the failure.",
			readOnly: true,
			inputSchema: {
				run_id: z
					.number()
					.int()
					.optional()
					.describe("Run/build ID from pipeline_runs. Defaults to the latest run on the current branch."),
				log_lines: z.number().int().min(0).max(500).default(40).describe("Lines of log to include per failed step."),
				workspace,
			},
			run: async (args) => {
				const [ctx, provider] = await open(args.workspace)
				let runId: number | undefined = args.run_id
				if (runId === undefined) {
					const [latest] = await provider.listRuns(ctx.branch, undefined, 1)
					if (!latest) {
						throw new DevOpsError(`No pipeline runs found for branch '${ctx.branch}'.`)
					}
					runId = latest.id
				}
				return runReport(await provider.runReport(runId, args.log_lines ?? 40))
			},
		},
		{
			name: "pr_checks",
			title: "Pull request checks",
			description: "Show the status checks (GitHub) or branch policies and statuses (Azure DevOps) on a pull request.",
			readOnly: true,
			inputSchema: { pr_id: prId, workspace },
			run: async (args) => {
				const [ctx, provider] = await open(args.workspace)
				const pr = await resolvePr(ctx, provider, args.pr_id)
				return checksTable(pr, await provider.prChecks(pr))
			},
		},
	]
}
