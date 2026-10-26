import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DevOpsError } from "./errors"

export type ProviderKind = "github" | "ado"

/** A parsed git remote. For GitHub `owner` is the user/org; for Azure DevOps it is the organization. */
export interface Remote {
	kind: ProviderKind
	host: string
	owner: string
	repo: string
	/** Azure DevOps only. */
	project?: string
	/**
	 * Azure DevOps Server (on-premises) only: the full path prefix before `{project}/_git/{repo}` — e.g.
	 * `tfs/Some_Collection` for `https://host/tfs/Some_Collection/{project}/_git/{repo}`. This can be a
	 * bare collection, or an application virtual directory (`tfs`) followed by the collection; either way it
	 * must be re-inserted verbatim ahead of `{project}` when building the REST API base URL.
	 */
	collection?: string
	/**
	 * Azure DevOps Server (on-premises) only: `{scheme}://{host}[:port]` for its web/REST API, defaulting to
	 * `https://{host}` on port 443. The git remote's own scheme/port (e.g. `ssh://host:22`) is for the git
	 * protocol only and must never be reused here — Azure DevOps Server serves its REST API over HTTPS on its
	 * own port, which is unrelated to the SSH port used for `git clone`.
	 */
	origin?: string
}

export interface RepoContext {
	root: string
	remoteName: string
	remote: Remote
	/** The remote's URL as git has it. */
	remoteUrl?: string
	/** Undefined when HEAD is detached. */
	branch?: string
}

export function remoteSlug(remote: Remote): string {
	return remote.kind === "ado" ? `${remote.owner}/${remote.project}/${remote.repo}` : `${remote.owner}/${remote.repo}`
}

export function remoteKey(remote: Remote): string {
	return `${remote.kind}|${remote.host}|${remoteSlug(remote)}`
}

/**
 * Whether two remotes name the same repository. Hosts and Azure DevOps paths
 * are case-insensitive, and an Azure DevOps Server can answer to several host
 * names (e.g. an old one in a clone's git remote and a new one in a pasted
 * link), so on-premises remotes match on collection, project and repository.
 */
export function sameRepository(a: Remote, b: Remote): boolean {
	if (a.kind === "ado" && b.kind === "ado" && a.collection && b.collection) {
		return remoteSlug(a).toLowerCase() === remoteSlug(b).toLowerCase()
	}
	return remoteKey(a).toLowerCase() === remoteKey(b).toLowerCase()
}

/**
 * Azure DevOps Server only: `{origin}/{collection path}`, where the collection path may have several segments
 * (e.g. "tfs/Some_Collection") that must stay separate path segments, not one encoded blob.
 */
export function adoCollectionUrl(remote: Remote): string | undefined {
	return remote.origin
		? `${remote.origin}/${(remote.collection ?? "").split("/").map(encodeURIComponent).join("/")}`
		: undefined
}

const stripGit = (name: string) => (name.endsWith(".git") ? name.slice(0, -4) : name)

/** Returns [scheme, host, port, path] for https://, ssh:// and scp-style (git@host:path) URLs. */
function splitUrl(url: string): [string, string, string, string] {
	if (url.includes("://")) {
		const parsed = new URL(url)
		return [
			parsed.protocol.replace(/:$/, ""),
			parsed.hostname.toLowerCase(),
			parsed.port,
			parsed.pathname.replace(/^\/+|\/+$/g, ""),
		]
	}
	const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url)
	if (!match) {
		throw new DevOpsError(`Cannot parse git remote URL: ${url}`)
	}
	return ["ssh", match[1].toLowerCase(), "", match[2].replace(/^\/+|\/+$/g, "")]
}

/**
 * Parses a git remote URL. Azure DevOps Services is recognised from dev.azure.com /
 * visualstudio.com hosts, github.com is GitHub, and any other host with a `_git` path
 * segment is treated as an on-premises Azure DevOps Server (TFS), since GitHub never
 * uses that segment. Anything else (e.g. GitHub Enterprise Server) needs `provider` to
 * say which API it speaks.
 */
export function parseRemote(url: string, provider?: string): Remote {
	const [scheme, host, port, rawPath] = splitUrl(url.trim())
	const segments = rawPath
		.split("/")
		.filter(Boolean)
		.map((s) => decodeURIComponent(s))

	const isAdoCloud = host.endsWith("dev.azure.com") || host.endsWith("visualstudio.com")
	const isAdoOnPrem = !isAdoCloud && host !== "github.com" && segments.includes("_git")
	let kind: ProviderKind
	if (provider === "github" || provider === "ado") {
		kind = provider
	} else if (isAdoCloud || isAdoOnPrem) {
		kind = "ado"
	} else if (host === "github.com") {
		kind = "github"
	} else {
		throw new DevOpsError(
			`Unrecognised git host '${host}'. Set DEVOPS_MCP_PROVIDER=github (GitHub Enterprise) or DEVOPS_MCP_PROVIDER=ado.`,
		)
	}

	if (kind === "github") {
		if (segments.length < 2) {
			throw new DevOpsError(`Cannot find owner/repo in GitHub remote URL: ${url}`)
		}
		return { kind, host, owner: segments[segments.length - 2], repo: stripGit(segments[segments.length - 1]) }
	}

	// Azure DevOps URL shapes:
	//   https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
	//   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
	//   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
	//   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
	// Azure DevOps Server (on-premises / TFS) additionally inserts a collection segment:
	//   https://{host}[:port]/{collection}/{project}/_git/{repo}
	//   ssh://{host}[:port]/{collection}/{project}/{repo}   (git@ prefix optional)
	let org: string | undefined
	let project: string
	let repo: string
	let collection: string | undefined
	const gitIndex = segments.indexOf("_git")
	if (isAdoCloud && segments[0] === "v3" && segments.length >= 4) {
		;[, org, project, repo] = segments
	} else if (isAdoCloud && gitIndex >= 1 && gitIndex + 1 < segments.length) {
		repo = segments[gitIndex + 1]
		project = segments[gitIndex - 1]
		if (host.endsWith("visualstudio.com")) {
			org = host.split(".")[0]
		} else if (gitIndex >= 2) {
			org = segments[gitIndex - 2]
		} else {
			throw new DevOpsError(`Cannot find the organization in Azure DevOps remote URL: ${url}`)
		}
	} else if (isAdoOnPrem && gitIndex >= 1 && gitIndex + 1 < segments.length) {
		// {virtual-directory-and-collection}/{project}/_git/{repo}, e.g. tfs/Some_Collection/Meshing/_git/repo.
		// Everything between the host and {project} (the app path, if any, plus the collection) must be kept
		// together and re-inserted as-is; only the host identifies the server, not this prefix's shape.
		repo = segments[gitIndex + 1]
		project = segments[gitIndex - 1]
		collection = segments.slice(0, gitIndex - 1).join("/")
	} else {
		throw new DevOpsError(`Cannot parse Azure DevOps remote URL: ${url}`)
	}

	if (isAdoOnPrem) {
		// The git remote's scheme/port (e.g. ssh://host:22 for `git clone`) is unrelated to the server's REST
		// API, which Azure DevOps Server always serves over HTTPS on its own port (443 unless the URL says
		// otherwise) — so an ssh:// remote's port must never carry over here.
		const origin =
			scheme === "https" || scheme === "http" ? `${scheme}://${host}${port ? `:${port}` : ""}` : `https://${host}`
		return { kind: "ado", host, owner: collection ?? "", repo: stripGit(repo), project, collection, origin }
	}
	if (!org) {
		throw new DevOpsError(`Cannot find the organization in Azure DevOps remote URL: ${url}`)
	}
	return { kind: "ado", host: "dev.azure.com", owner: org, repo: stripGit(repo), project }
}

export type GitFailureReason = "git-missing" | "dubious-ownership" | "not-a-repo" | "other"

export type GitRunFailure = {
	ok: false
	stderr: string
	reason: GitFailureReason
}

export type GitRunSuccess = { ok: true; stdout: string }

export type GitRunResult = GitRunSuccess | GitRunFailure

function classifyGitFailure(stderr: string): GitFailureReason {
	const lower = stderr.toLowerCase()
	if (lower.includes("dubious ownership") || lower.includes("safe.directory")) {
		return "dubious-ownership"
	}
	if (lower.includes("not a git repository") || lower.includes("not a git repo")) {
		return "not-a-repo"
	}
	return "other"
}

export function formatGitRepoFailureMessage(start: string, failure: GitRunFailure): string {
	switch (failure.reason) {
		case "git-missing":
			return `Git is not installed or not on PATH (needed to find the repository for ${start}). Install Git and ensure the editor can run it.`
		case "dubious-ownership":
			return `Git refused to use the repository at ${start} because of dubious ownership. Add the repository root to safe.directory, for example: git config --global --add safe.directory <path>. Details: ${failure.stderr}`
		case "not-a-repo":
			return `${start} is not inside a git repository. Open the repository folder (or a subfolder of it) in the workspace. Details: ${failure.stderr}`
		default:
			return `${start} is not inside a git repository (or git failed). ${failure.stderr}`
	}
}

export function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) {
				resolve({ ok: true, stdout: stdout.trim() })
				return
			}
			const err = error as NodeJS.ErrnoException
			const stderrText = String(stderr).trim() || err.message
			if (err.code === "ENOENT") {
				resolve({ ok: false, stderr: stderrText, reason: "git-missing" })
				return
			}
			resolve({ ok: false, stderr: stderrText, reason: classifyGitFailure(stderrText) })
		})
	})
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return runGit(cwd, args).then((result) => (result.ok ? result.stdout : undefined))
}

export async function resolveRepoRoot(start: string): Promise<{ root: string } | GitRunFailure> {
	const result = await runGit(start, ["rev-parse", "--show-toplevel"])
	if (result.ok) {
		return { root: result.stdout }
	}
	return result
}

function resolveWorkspace(workspace?: string): string {
	const raw = workspace || process.env.DEVOPS_MCP_WORKSPACE || process.cwd()
	const expanded = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw
	if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
		throw new DevOpsError(`Workspace folder does not exist: ${expanded}`)
	}
	return expanded
}

export async function loadContext(workspace?: string): Promise<RepoContext> {
	const start = resolveWorkspace(workspace)
	const resolved = await resolveRepoRoot(start)
	if (!("root" in resolved)) {
		throw new DevOpsError(
			`${formatGitRepoFailureMessage(start, resolved)} Pass \`workspace\` with the absolute path of the repository when needed.`,
		)
	}
	const root = resolved.root
	const remoteName = process.env.DEVOPS_MCP_REMOTE || "origin"
	const url = await git(root, ["remote", "get-url", remoteName])
	if (!url) {
		throw new DevOpsError(`The repository at ${root} has no remote named '${remoteName}' (set DEVOPS_MCP_REMOTE).`)
	}
	const remote = parseRemote(url, process.env.DEVOPS_MCP_PROVIDER)
	const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
	return { root, remoteName, remote, remoteUrl: url, branch: branch || undefined }
}

/**
 * True when the git repository at `cwd` has a remote this server can work
 * with (GitHub, Azure DevOps, or any host when DEVOPS_MCP_PROVIDER is set).
 */
export async function hasSupportedRemote(cwd: string): Promise<boolean> {
	const resolved = await resolveRepoRoot(cwd)
	if (!("root" in resolved)) {
		return false
	}
	const remotes = await git(resolved.root, ["remote", "-v"])
	if (!remotes) {
		return false
	}
	for (const line of remotes.split("\n")) {
		const url = line.trim().split(/\s+/)[1]
		if (!url) {
			continue
		}
		try {
			parseRemote(url, process.env.DEVOPS_MCP_PROVIDER)
			return true
		} catch {
			// Not a host this server knows; try the next remote.
		}
	}
	return false
}

/** The commit `branch` points at on the remote as of the last push or fetch, or undefined when it was never pushed. */
export function remoteBranchHead(ctx: RepoContext, branch: string): Promise<string | undefined> {
	return git(ctx.root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ctx.remoteName}/${branch}^{commit}`])
}

/** Describes why `branch` is not fully pushed, or returns undefined when it is. */
export async function pushProblem(ctx: RepoContext, branch: string): Promise<string | undefined> {
	const ref = `refs/remotes/${ctx.remoteName}/${branch}`
	if ((await git(ctx.root, ["rev-parse", "--verify", "--quiet", ref])) === undefined) {
		return `Branch '${branch}' has not been pushed. Run \`git push -u ${ctx.remoteName} ${branch}\` first.`
	}
	if (ctx.branch === branch) {
		const ahead = await git(ctx.root, ["rev-list", "--count", `${ref}..HEAD`])
		if (ahead && ahead !== "0") {
			return `Branch '${branch}' has ${ahead} local commit(s) not pushed to ${ctx.remoteName}.`
		}
	}
	return undefined
}
