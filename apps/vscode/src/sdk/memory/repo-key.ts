// Which repository a folder belongs to, for repo memory (docs/memory.md).
//
// Memory is keyed by the repository, not by the folder: every clone and every
// git worktree of one repository, CI Board worktrees included, shares one
// memory. The key is the `origin` remote with its protocol, user and `.git`
// stripped. A repository without a remote is keyed by its top-level folder,
// and a folder outside git by the folder itself.

import { createHash } from "node:crypto"
import * as path from "node:path"
import { runGit as defaultRunGit, type GitRunner } from "../context/git-snapshot"

const GIT_TIMEOUT_MS = 2000
const MAX_SLUG_LENGTH = 60

export interface RepoIdentity {
	/** How the repository was recognised. */
	kind: "remote" | "toplevel" | "folder"
	/** The normalized remote (`github.com/org/repo`) or folder path the key is made from. */
	identity: string
	/** The directory name under `memory/repos/`: a readable slug plus a short hash of `identity`. */
	key: string
	/** The remote URL as git reports it, for the `repo.json` note. */
	remoteUrl?: string
}

/**
 * `git@github.com:Org/Repo.git`, `https://user@dev.azure.com/org/p/_git/r` and
 * `ssh://git@host:22/org/repo` all become `host/path`, lower-cased: the hosts
 * PlinyCode works with treat repository names case-insensitively.
 */
export function normalizeRemoteUrl(url: string): string | undefined {
	let rest = url.trim()
	if (!rest) {
		return undefined
	}
	const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\//i)
	if (scheme) {
		rest = rest.slice(scheme[0].length)
		// user[:password]@
		rest = rest.replace(/^[^@/]*@/, "")
		// host:port/ → host/
		rest = rest.replace(/^([^/:]+):\d+(?=\/)/, "$1")
	} else {
		// scp-like: [user@]host:path. `C:\repos\x` is a Windows path, not host `C`.
		const scp = /^[a-z]:[\\/]/i.test(rest) ? null : rest.match(/^(?:[^@/\\]+@)?([^:/\\]+):(.+)$/)
		if (!scp) {
			// A local path used as a remote.
			return normalizeFolderPath(rest)
		}
		rest = `${scp[1]}/${scp[2]}`
	}
	rest = rest
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.replace(/\/{2,}/g, "/")
	return rest ? rest.toLowerCase() : undefined
}

/** Forward slashes, no trailing slash, and lower case on Windows, where paths are case-insensitive. */
export function normalizeFolderPath(folder: string, platform: NodeJS.Platform = process.platform): string {
	const resolved = path.resolve(folder).replace(/\\/g, "/").replace(/\/+$/, "")
	return platform === "win32" ? resolved.toLowerCase() : resolved
}

/** `github.com/synopsys/plinycode` → `synopsys-plinycode-1a2b3c4d`. */
export function repoKeyFromIdentity(identity: string): string {
	const hash = createHash("sha1").update(identity).digest("hex").slice(0, 8)
	const slug = identity
		.split("/")
		.filter(Boolean)
		.slice(-2)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, MAX_SLUG_LENGTH)
	return slug ? `${slug}-${hash}` : hash
}

async function gitOutput(runGit: GitRunner, cwd: string, args: string[]): Promise<string | undefined> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), GIT_TIMEOUT_MS)
	try {
		const result = await runGit(args, { cwd, signal: controller.signal })
		const out = result.stdout.trim()
		return result.exitCode === 0 && out ? out : undefined
	} catch {
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

/** The repository `cwd` belongs to. Never throws: without git, the folder is its own repository. */
export async function resolveRepoIdentity(cwd: string, runGit: GitRunner = defaultRunGit): Promise<RepoIdentity> {
	const remoteUrl = await gitOutput(runGit, cwd, ["remote", "get-url", "origin"])
	const remote = remoteUrl ? normalizeRemoteUrl(remoteUrl) : undefined
	if (remote) {
		return { kind: "remote", identity: remote, key: repoKeyFromIdentity(remote), remoteUrl }
	}
	const toplevel = await gitOutput(runGit, cwd, ["rev-parse", "--show-toplevel"])
	if (toplevel) {
		const identity = normalizeFolderPath(toplevel)
		return { kind: "toplevel", identity, key: repoKeyFromIdentity(identity) }
	}
	const identity = normalizeFolderPath(cwd)
	return { kind: "folder", identity, key: repoKeyFromIdentity(identity) }
}
