/** The provider-neutral PR and pipeline tools. Plain functions, so tests can call them without MCP. */
import { z } from "zod"
import { type PreparedLaunch, preparePipelineLaunch } from "../pipelines/pipeline-launch"
import { DevOpsError } from "./errors"
import { AzureDevOpsProvider } from "./providers/azdo"
import { GitHubProvider } from "./providers/github"
import { checkBody, type PullRequest, type ToolProvider } from "./providers/types"
import { loadContext, pushProblem, type Remote, type RepoContext, remoteKey, remoteSlug } from "./repo"
import { checksTable, commentsReport, prSummary, runReport, runsTable, setSection } from "./report"

export const INSTRUCTIONS = `Pull requests and CI pipelines for the git repository you are working in. The same tools work
for GitHub (Actions) and Azure DevOps (Repos + Pipelines); the backend is chosen from the git remote.

- Call repo_context first to see the provider, current branch, default branch and any open PR.
- Pass \`workspace\` (the absolute path of the repository) on every call when you know it.
- PR descriptions are Markdown. Azure DevOps limits them to 4000 characters, GitHub to 65536.
- To keep generated content (e.g. CI results) current without overwriting hand-written text,
  use pr_update with a \`section\` name; only that section is replaced.
- pr_create opens drafts by default. To publish one (mark it ready for review), call pr_update with
  \`draft: false\`; \`draft: true\` turns a PR back into a draft.
- Pipeline runs take minutes. Do not loop on pipeline_runs; check again later when asked.
- pr_comments lists review threads newest first, each with the id pr_comment takes as \`reply_to\`.
- pr_comment, pr_review, pipeline_run, pipeline_rerun and pipeline_cancel act for the user where other
  people see it: use them when the user asked for that, not on your own initiative.`

type ProviderFactory = (remote: Remote) => ToolProvider

/** Where a launch went: `recorded` when it is in the Pipelines view's run history. */
interface PipelineLaunched {
	runId?: number
	url: string
	recorded: boolean
}

/** Queues a launch `pipeline_run` prepared. The extension host passes one that records it in the run history. */
type PipelineLauncher = (request: {
	ctx: RepoContext
	provider: ToolProvider
	prepared: PreparedLaunch
}) => Promise<PipelineLaunched>

/** Queues straight through the provider: what the server process does, for every MCP client. */
const queueDirectly: PipelineLauncher = async ({ provider, prepared }) => {
	const dispatch = await provider.queuePipeline(prepared.pipeline.id, prepared.ref, prepared.inputs)
	return { runId: dispatch.runId, url: dispatch.url, recorded: false }
}

function defaultProviderFactory(): ProviderFactory {
	const cache = new Map<string, ToolProvider>()
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
// `coerce`: the free models send numbers as strings (`"limit": "20"`), and a
// strict schema turned two dozen otherwise-correct calls into validation errors.
const prId = z.coerce.number().int().optional().describe("PR number/ID. Defaults to the open PR for the current branch.")
const runId = z.coerce.number().int().positive().describe("Run/build ID from pipeline_runs.")

export interface ToolDefinition {
	name: string
	title: string
	description: string
	readOnly: boolean
	/** Undoes or stops something (MCP `destructiveHint`). */
	destructive?: boolean
	inputSchema: z.ZodRawShape
	run: (args: any) => Promise<string>
}

/** A tool call as an MCP result: errors we raise on purpose are written for the model, anything else is a bug. */
export async function callTool(
	tool: ToolDefinition,
	args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
	try {
		return { content: [{ type: "text", text: await tool.run(args) }] }
	} catch (error) {
		const message = error instanceof DevOpsError ? error.message : `Unexpected error: ${String(error)}`
		return { content: [{ type: "text", text: message }], isError: true }
	}
}

function inputsObject(value: unknown): Record<string, unknown> {
	let inputs = value ?? {}
	if (typeof inputs === "string") {
		try {
			inputs = inputs.trim() ? JSON.parse(inputs) : {}
		} catch {
			throw new DevOpsError("`inputs` must be an object of input names and values.")
		}
	}
	if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
		throw new DevOpsError("`inputs` must be an object of input names and values.")
	}
	return inputs as Record<string, unknown>
}

export function createTools(
	providerFor: ProviderFactory = defaultProviderFactory(),
	launchPipeline: PipelineLauncher = queueDirectly,
): ToolDefinition[] {
	const open = async (ws?: string): Promise<[RepoContext, ToolProvider]> => {
		const ctx = await loadContext(ws)
		return [ctx, providerFor(ctx.remote)]
	}

	const resolvePr = async (ctx: RepoContext, provider: ToolProvider, id?: number): Promise<PullRequest> => {
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
				"Update a pull request's title, Markdown description (the whole description, or only one named section) and/or draft status.",
			readOnly: false,
			destructive: true,
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
				draft: z
					.boolean()
					.optional()
					.describe(
						"false publishes a draft PR (marks it ready for review); true converts it back to a draft. Omit to leave it as is.",
					),
				workspace,
			},
			run: async (args) => {
				if (args.title === undefined && args.body === undefined && args.draft === undefined) {
					throw new DevOpsError("Nothing to update: pass `title`, `body` and/or `draft`.")
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
				return prSummary(await provider.updatePr(pr.id, args.title, body, args.draft), "Updated pull request")
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
				pr_id: z.coerce
					.number()
					.int()
					.optional()
					.describe("List the runs for this PR (its latest commit / PR build) instead of a branch."),
				limit: z.coerce.number().int().min(1).max(50).default(10),
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
				run_id: z.coerce
					.number()
					.int()
					.optional()
					.describe("Run/build ID from pipeline_runs. Defaults to the latest run on the current branch."),
				log_lines: z.coerce
					.number()
					.int()
					.min(0)
					.max(500)
					.default(40)
					.describe("Lines of log to include per failed step."),
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
		{
			name: "pr_comments",
			title: "Pull request comments",
			description:
				"List a pull request's discussion, the most recently active first: inline review threads (file:line), general comments and review verdicts, with each thread's resolved state, its latest comments (first 300 characters) and the id pr_comment takes as `reply_to`.",
			readOnly: true,
			inputSchema: {
				pr_id: prId,
				limit: z.coerce.number().int().min(1).max(100).default(20).describe("Most threads to list."),
				workspace,
			},
			run: async (args) => {
				const [ctx, provider] = await open(args.workspace)
				const pr = await resolvePr(ctx, provider, args.pr_id)
				return commentsReport(pr, provider.kind, await provider.listPrThreads(pr), args.limit ?? 20)
			},
		},
		{
			name: "pr_comment",
			title: "Comment on pull request",
			description:
				"Post a Markdown comment on a pull request: a general comment, an inline comment on a line of a changed file (in the PR's latest commit), or a reply in an existing thread (`reply_to`, from pr_comments).",
			readOnly: false,
			inputSchema: {
				pr_id: prId,
				body: z.string().describe("The comment, in Markdown."),
				path: z
					.string()
					.optional()
					.describe(
						"File to comment on, relative to the repository root; needs `line`. The file must be one the PR changes.",
					),
				line: z.coerce
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Line of `path` in the PR's new version of the file; needs `path`."),
				reply_to: z
					.union([z.string(), z.number()])
					.optional()
					.describe("Thread id from pr_comments to reply in, instead of starting a new thread."),
				workspace,
			},
			run: async (args) => {
				const body = typeof args.body === "string" ? args.body : ""
				if (!body.trim()) {
					throw new DevOpsError("`body` is empty: pass the comment text.")
				}
				if ((args.path === undefined) !== (args.line === undefined)) {
					throw new DevOpsError("`path` and `line` go together: pass both for an inline comment, or neither.")
				}
				if (args.reply_to !== undefined && args.path !== undefined) {
					throw new DevOpsError("A reply goes in its thread: pass `reply_to` or `path` and `line`, not both.")
				}
				const [ctx, provider] = await open(args.workspace)
				const pr = await resolvePr(ctx, provider, args.pr_id)
				const replyTo = args.reply_to === undefined ? undefined : String(args.reply_to)
				const posted = await provider.addPrComment(pr, { body, path: args.path, line: args.line, replyTo })
				const what =
					posted.kind === "reply"
						? `a reply in thread ${posted.replyId}`
						: posted.kind === "inline comment"
							? `an inline comment on ${args.path}:${args.line}`
							: "a comment"
				const next =
					posted.replyId && posted.kind !== "reply"
						? `\nTo reply in this thread, pass reply_to: ${posted.replyId}.`
						: ""
				return `Posted ${what} on PR #${pr.id}: ${posted.url}${next}`
			},
		},
		{
			name: "pr_review",
			title: "Review pull request",
			description:
				"Submit a review verdict on a pull request: approve, request_changes or comment, with an optional Markdown summary. GitHub: a pull request review. Azure DevOps: your reviewer vote (approve = Approved, 10; request_changes = Waiting for author, -5; comment leaves the vote unchanged), with the summary posted as a comment.",
			readOnly: false,
			inputSchema: {
				pr_id: prId,
				verdict: z.enum(["approve", "request_changes", "comment"]).describe("The review's verdict."),
				body: z
					.string()
					.optional()
					.describe("Review summary in Markdown. Needed for `comment`, and for `request_changes` on GitHub."),
				workspace,
			},
			run: async (args) => {
				if (args.verdict === "comment" && !args.body?.trim()) {
					throw new DevOpsError("A `comment` review needs a `body`.")
				}
				const [ctx, provider] = await open(args.workspace)
				const pr = await resolvePr(ctx, provider, args.pr_id)
				if (pr.state !== "open") {
					throw new DevOpsError(`PR #${pr.id} is ${pr.state}; only an open pull request can be reviewed.`)
				}
				return provider.reviewPr(pr, args.verdict, args.body)
			},
		},
		{
			name: "pipeline_run",
			title: "Run pipeline",
			description:
				"Queue a GitHub Actions workflow (workflow_dispatch) or an Azure Pipelines YAML pipeline on a branch, with typed inputs checked against the pipeline's YAML at that branch.",
			readOnly: false,
			inputSchema: {
				pipeline: z
					.union([z.string(), z.number()])
					.describe("The pipeline: its name or id, or on GitHub its workflow file name (e.g. build.yml)."),
				branch: z
					.string()
					.optional()
					.describe("Branch (or refs/tags/<tag>) to run on. Defaults to the current branch, which must be pushed."),
				inputs: z
					.union([z.record(z.string(), z.unknown()), z.string()])
					.optional()
					.describe(
						"Workflow inputs (GitHub) or runtime parameters (Azure DevOps) by name; the ones left out take their defaults. Wrong names or values are refused with the list of inputs.",
					),
				workspace,
			},
			run: async (args) => {
				const inputs = inputsObject(args.inputs)
				const [ctx, provider] = await open(args.workspace)
				let ref: string | undefined = args.branch?.trim() || undefined
				let note = ""
				if (!ref && ctx.branch) {
					const problem = await pushProblem(ctx, ctx.branch)
					if (problem?.includes("not been pushed")) {
						throw new DevOpsError(`${problem} Push it, or pass \`branch\`.`)
					}
					if (problem) note = `\nWarning: ${problem} The run uses the pushed commit.`
					ref = ctx.branch
				}
				ref ??= await provider.defaultBranch()
				const prepared = await preparePipelineLaunch(provider, { pipeline: String(args.pipeline), ref, inputs })
				const launched = await launchPipeline({ ctx, provider, prepared })
				const name = `${prepared.pipeline.name} on ${ref} (${provider.kind})`
				const lines = [
					launched.runId
						? `Queued ${name}: run ${launched.runId}, ${launched.url}`
						: `${provider.kind} accepted ${name} but did not say which run it started (older GitHub Enterprise Server); find it with pipeline_runs. ${launched.url}`,
				]
				if (Object.keys(prepared.inputs).length) lines.push(`Inputs: ${JSON.stringify(prepared.inputs)}`)
				if (launched.recorded) {
					lines.push("It is in the Pipelines view's run history, which tells the user when it finishes.")
				}
				lines.push("Runs take minutes: do not loop on pipeline_runs.")
				return lines.join("\n") + note
			},
		},
		{
			name: "pipeline_cancel",
			title: "Cancel pipeline run",
			description: "Cancel a GitHub Actions run or Azure Pipelines build that has not finished.",
			readOnly: false,
			destructive: true,
			inputSchema: { run_id: runId, workspace },
			run: async (args) => {
				const [, provider] = await open(args.workspace)
				const run = await provider.getRun(args.run_id)
				if (run.status === "completed") {
					throw new DevOpsError(
						`Run ${run.id} (${run.name}) already finished: ${run.result ?? "unknown"}. There is nothing to cancel; pipeline_rerun runs it again.`,
					)
				}
				await provider.cancelRun(run.id)
				return `Asked ${provider.kind} to cancel run ${run.id} (${run.name} on ${run.branch}, ${run.status.replace("_", " ")}): ${run.url}\nIt can take a moment to stop.`
			},
		},
		{
			name: "pipeline_rerun",
			title: "Rerun pipeline run",
			description:
				"Run a finished GitHub Actions run or Azure Pipelines build again, all of it or only its failed jobs. GitHub reruns it in place (a new attempt, same run id). Azure DevOps retries the failed jobs of the same build, or for a full rerun queues a new build of the same pipeline, branch and parameters.",
			readOnly: false,
			inputSchema: {
				run_id: runId,
				failed_only: z.boolean().default(false).describe("Rerun only the jobs that failed or were cancelled."),
				workspace,
			},
			run: async (args) => {
				const [, provider] = await open(args.workspace)
				const run = await provider.getRun(args.run_id)
				if (run.status !== "completed") {
					throw new DevOpsError(
						`Run ${run.id} (${run.name}) is still ${run.status.replace("_", " ")}. Wait for it to finish, or stop it with pipeline_cancel first.`,
					)
				}
				const failedOnly = args.failed_only ?? false
				if (failedOnly && run.result === "success") {
					throw new DevOpsError(
						`Run ${run.id} (${run.name}) succeeded, so no job failed; rerun it without failed_only.`,
					)
				}
				const dispatch = await provider.rerunRun(run.id, failedOnly)
				if (dispatch.runId === run.id || dispatch.runId === undefined) {
					return `${failedOnly ? "Rerunning the failed jobs of" : "Rerunning"} run ${run.id} (${run.name} on ${run.branch}) as a new attempt of the same run: ${dispatch.url}`
				}
				return `Queued run ${dispatch.runId} of ${run.pipeline ?? run.name} on ${run.branch} with the same parameters, to rerun ${run.id}: ${dispatch.url}`
			},
		},
	]
}
