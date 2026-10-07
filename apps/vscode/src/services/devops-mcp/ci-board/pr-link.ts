/** Reads what the user typed into the board: a pull request link, or a branch name. */
import { parseRemote, type Remote } from "../server/repo"

interface PrLink {
	remote: Remote
	/** The repository part of the link, kept as the target's remote URL. */
	remoteUrl: string
	prId: number
}

const GITHUB_PR = /^(https?:\/\/[^/?#]+\/[^/?#]+\/[^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i
const ADO_PR = /^(https?:\/\/[^?#]+\/_git\/[^/?#]+)\/pullrequest\/(\d+)(?:[/?#].*)?$/i

/**
 * A GitHub (`…/owner/repo/pull/12`) or Azure DevOps (`…/_git/repo/pullrequest/12`,
 * cloud or on-premises) pull request link, or undefined for anything else. The
 * suffix is cut off first: `parseRemote` would read `pull` as the owner.
 */
export function parsePrLink(input: string): PrLink | undefined {
	const text = input.trim()
	const github = GITHUB_PR.exec(text)
	const ado = github ? undefined : ADO_PR.exec(text)
	const match = github ?? ado
	if (!match) {
		return undefined
	}
	try {
		// `/pull/N` is GitHub's shape, so it also identifies GitHub Enterprise hosts.
		const remote = parseRemote(match[1], github ? "github" : "ado")
		return { remote, remoteUrl: match[1], prId: Number(match[2]) }
	} catch {
		return undefined
	}
}

/** What git accepts as a branch name, roughly; enough to catch a pasted URL or stray text. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\]+(?<![./])$/

type TargetInput = { kind: "pr"; link: PrLink } | { kind: "branch"; branch: string } | { kind: "invalid"; reason: string }

export function classifyTargetInput(input: string): TargetInput {
	const text = input.trim()
	if (!text) {
		return { kind: "invalid", reason: "Paste a pull request link or type a branch name." }
	}
	const link = parsePrLink(text)
	if (link) {
		return { kind: "pr", link }
	}
	if (/^[a-z]+:\/\//i.test(text)) {
		return {
			kind: "invalid",
			reason: "That link is not a pull request. Use a GitHub …/pull/N or Azure DevOps …/pullrequest/N link.",
		}
	}
	if (!BRANCH.test(text)) {
		return { kind: "invalid", reason: `'${text}' is not a valid branch name.` }
	}
	return { kind: "branch", branch: text }
}
