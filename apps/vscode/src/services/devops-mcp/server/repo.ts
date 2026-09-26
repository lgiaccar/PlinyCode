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
	 * Azure DevOps Server (on-premises) only: the collection path segment (e.g. `tfs` or `DefaultCollection`)
	 * and the scheme/port to reach it with, since an on-prem server isn't always plain `https://{host}`.
	 */
	collection?: string
	/** Azure DevOps Server (on-premises) only: `{scheme}://{host}[:port]`, defaulting to `https://{host}`. */
	origin?: string
}

export interface RepoContext {
	root: string
	remoteName: string
	remote: Remote
	/** Undefined when HEAD is detached. */
	branch?: string
}

export function remoteSlug(remote: Remote): string {
	return remote.kind === "ado" ? `${remote.owner}/${remote.project}/${remote.repo}` : `${remote.owner}/${remote.repo}`
}

export function remoteKey(remote: Remote): string {
	return `${remote.kind}|${remote.host}|${remoteSlug(remote)}`
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
	} else if (isAdoOnPrem && gitIndex >= 2 && gitIndex + 1 < segments.length) {
		// {collection}/{project}/_git/{repo}, with an optional leading path prefix (e.g. /tfs/).
		repo = segments[gitIndex + 1]
		project = segments[gitIndex - 1]
		collection = segments[gitIndex - 2]
	} else {
		throw new DevOpsError(`Cannot parse Azure DevOps remote URL: ${url}`)
	}

	if (isAdoOnPrem) {
		const origin = `${scheme === "ssh" ? "https" : scheme}://${host}${port ? `:${port}` : ""}`
		return { kind: "ado", host, owner: collection ?? "", repo: stripGit(repo), project, collection, origin }
	}
	if (!org) {
		throw new DevOpsError(`Cannot find the organization in Azure DevOps remote URL: ${url}`)
	}
	return { kind: "ado", host: "dev.azure.com", owner: org, repo: stripGit(repo), project }
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim())
		})
	})
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
	const root = await git(start, ["rev-parse", "--show-toplevel"])
	if (!root) {
		throw new DevOpsError(
			`${start} is not inside a git repository (or git is not installed). Pass \`workspace\` with the absolute path of the repository.`,
		)
	}
	const remoteName = process.env.DEVOPS_MCP_REMOTE || "origin"
	const url = await git(root, ["remote", "get-url", remoteName])
	if (!url) {
		throw new DevOpsError(`The repository at ${root} has no remote named '${remoteName}' (set DEVOPS_MCP_REMOTE).`)
	}
	const remote = parseRemote(url, process.env.DEVOPS_MCP_PROVIDER)
	const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
	return { root, remoteName, remote, branch: branch || undefined }
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
