/**
 * The approval policy of a CI board run. A run works in one working copy of a
 * pull request's branch and may push only that branch, never with force.
 *
 * - `auto` (auto-watch runs, unattended in the background): what fits the run
 *   is approved and everything else is denied with a reason the model can act
 *   on, since nobody is there to approve it.
 * - `guard` (runs the user started): only the denials apply; anything else
 *   follows the user's auto-approve settings.
 *
 * Command parsing is best effort (a command can hide another inside
 * `bash -c`); the narrow push rule and the working copy are the boundary.
 */
import path from "node:path"

export interface CiRunPolicy {
	scope: "auto" | "guard"
	/** The run's working copy. */
	worktree: string
	/** The git remote the branch is pushed to. */
	remoteName: string
	/** The only branch the run may push to. */
	sourceBranch: string
	/** Folders the run may read besides its working copy (the report folder, the repository, skills). */
	readRoots: string[]
}

type CiDecision = { kind: "approve" } | { kind: "deny"; reason: string } | { kind: "ask" }

const APPROVE: CiDecision = { kind: "approve" }
const ASK: CiDecision = { kind: "ask" }
const deny = (reason: string): CiDecision => ({ kind: "deny", reason })

const EDIT_TOOLS = new Set(["editor", "replace_in_file", "write_to_file", "delete_file"])
const READ_TOOLS = new Set([
	"read_files",
	"read_file",
	"list_files",
	"list_code_definition_names",
	"search_codebase",
	"search_files",
	"find_files",
	"view_image",
])
const COMMAND_TOOLS = new Set(["run_commands", "execute_command"])
// A run's own background processes: it sees and stops only those of its conversation.
const PROCESS_TOOLS = new Set(["process_list", "process_output", "process_kill"])
const DEVOPS_READ_TOOLS = new Set(["repo_context", "pr_get", "pr_checks", "pr_comments", "pipeline_runs", "pipeline_report"])
/**
 * DevOps tools that act where other people see it, with the reason an unattended run is refused each one. An
 * unattended run may not create or update pull requests either (`pr_create`, `pr_update` fall under "any other
 * tool"), so posting comments is refused like them: the run reports what it would say instead.
 */
const DEVOPS_UNATTENDED_REFUSALS: Record<string, string> = {
	pr_review:
		"Approving a pull request or requesting changes is a reviewer's decision, and an unattended CI run does not review; report what you found instead.",
	pr_comment:
		"An unattended CI run does not post on pull requests (it does not create or update them either); put what you would say in your report instead.",
	pipeline_run:
		"Starting a pipeline can deploy or use shared build capacity, so an unattended CI run does not start one; your push already triggers CI. Report it instead.",
	pipeline_cancel:
		"Cancelling a pipeline run can stop someone else's build or deployment, so an unattended CI run does not cancel runs; report it instead.",
	pipeline_rerun:
		"An unattended CI run does not rerun pipelines (it does not run `gh run rerun` either); if a failure looks flaky, say so in your report.",
}

const caseless = process.platform === "win32"

function isInside(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(root, target))
	const rel = caseless ? relative.toLowerCase() : relative
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function insideGitDir(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(root, target))
	return /^\.git(?:[\\/]|$)/i.test(relative)
}

/** Every path-looking value of a tool input: `path`, `file_path`, `filePath`, `paths`, `files[].path`. */
function inputPaths(input: unknown): string[] {
	if (typeof input === "string") return [input]
	if (!input || typeof input !== "object") return []
	const out: string[] = []
	const record = input as Record<string, unknown>
	for (const key of ["path", "file_path", "filePath", "absolutePath"]) {
		if (typeof record[key] === "string") out.push(record[key] as string)
	}
	for (const key of ["paths", "files"]) {
		const list = record[key]
		if (Array.isArray(list)) {
			for (const entry of list) out.push(...inputPaths(entry))
		}
	}
	return out
}

/** The files an `apply_patch` input touches, from its `*** Add/Update/Delete File:` and `*** Move to:` headers. */
function patchPaths(input: unknown): string[] {
	const text =
		typeof input === "string"
			? input
			: input && typeof input === "object" && typeof (input as { input?: unknown }).input === "string"
				? ((input as { input: string }).input as string)
				: ""
	const out: string[] = []
	for (const match of text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) {
		out.push(match[1])
	}
	return out
}

/** The commands of a `run_commands` input, as command lines. */
function commandLines(input: unknown): string[] {
	const one = (entry: unknown): string[] => {
		if (typeof entry === "string") return [entry]
		if (Array.isArray(entry)) return entry.flatMap(one)
		if (entry && typeof entry === "object") {
			const e = entry as { commands?: unknown; command?: unknown; args?: unknown; cmd?: unknown }
			if (e.commands !== undefined) return one(e.commands)
			if (typeof e.command === "string") {
				const args = Array.isArray(e.args) ? e.args.map(String) : []
				return [[e.command, ...args].join(" ")]
			}
			if (typeof e.cmd === "string") return [e.cmd]
		}
		return []
	}
	return one(input)
}

/** Splits a command line on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. */
function splitSegments(line: string): string[] {
	const segments: string[] = []
	let current = ""
	let quote: string | undefined
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (quote) {
			current += ch
			if (ch === quote) quote = undefined
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			current += ch
			continue
		}
		if (ch === "\n" || ch === "\r" || ch === ";" || ch === "|" || ch === "&") {
			if (current.trim()) segments.push(current.trim())
			current = ""
			if ((ch === "|" || ch === "&") && line[i + 1] === ch) i++
			continue
		}
		current += ch
	}
	if (current.trim()) segments.push(current.trim())
	return segments
}

/** Words of a command, with quotes removed. */
function words(segment: string): string[] {
	const out: string[] = []
	for (const match of segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		out.push(match[1] ?? match[2] ?? match[3])
	}
	return out
}

const FORCE_FLAGS = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--all|--delete|-d|--prune|--tags)$/

function decidePush(policy: CiRunPolicy, args: string[]): CiDecision {
	const how = `Push with \`git push ${policy.remoteName} HEAD:${policy.sourceBranch}\`.`
	const positional: string[] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg.startsWith("-")) {
			if (FORCE_FLAGS.test(arg) || /^-[a-z]*f[a-z]*$/i.test(arg)) {
				return deny(`CI board runs never force-push, delete or mirror (\`${arg}\`). ${how}`)
			}
			if (arg === "--repo" || arg === "-o" || arg === "--push-option" || arg === "--receive-pack") i++
			continue
		}
		positional.push(arg)
	}
	if (positional.length < 2) {
		return policy.scope === "auto" ? deny(`Name the remote and branch so the push can be checked. ${how}`) : ASK
	}
	const [remote, ...refspecs] = positional
	if (remote !== policy.remoteName) {
		return deny(`CI board runs push only to the remote ${policy.remoteName}. ${how}`)
	}
	for (const refspec of refspecs) {
		if (refspec.startsWith("+")) {
			return deny(`A refspec starting with + is a force-push. ${how}`)
		}
		if (refspec.startsWith(":")) {
			return deny(`A refspec with nothing before the colon deletes the remote branch. ${how}`)
		}
		const destination = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec
		if (destination !== policy.sourceBranch && destination !== `refs/heads/${policy.sourceBranch}`) {
			return deny(`CI board runs may push only to ${policy.sourceBranch}, not ${destination || "(delete)"}. ${how}`)
		}
	}
	return APPROVE
}

const ASK_GIT = new Set(["rebase", "filter-branch", "filter-repo", "update-ref", "worktree", "remote", "replace"])
const READ_ONLY_CLI = new Set(["view", "list", "show", "checks", "status", "diff", "log"])
const FILE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"del",
	"erase",
	"rd",
	"remove-item",
	"ri",
	"mv",
	"move",
	"move-item",
	"cp",
	"copy",
	"copy-item",
	"cd",
	"set-location",
	"pushd",
	"mklink",
	"new-item",
	"set-content",
	"add-content",
	"out-file",
	"tee",
])

const CMD_SWITCH_COMMANDS = new Set(["del", "erase", "rd", "rmdir", "move", "copy", "mklink"])

function decideGit(policy: CiRunPolicy, args: string[]): CiDecision {
	let i = 0
	while (i < args.length && args[i].startsWith("-")) {
		if (args[i] === "-C") {
			const dir = args[i + 1] ?? ""
			if (!isInside(policy.worktree, dir)) {
				return deny(`CI board runs work only in ${policy.worktree}; run git there, without -C ${dir}.`)
			}
			i += 2
			continue
		}
		if (args[i] === "-c") {
			i += 2
			continue
		}
		i++
	}
	const sub = args[i]
	const rest = args.slice(i + 1)
	if (sub === "push") {
		return decidePush(policy, rest)
	}
	const unattended = policy.scope === "auto"
	const refuse = (what: string) =>
		unattended ? deny(`${what} is not allowed in an unattended CI run; report it instead.`) : ASK
	if (ASK_GIT.has(sub)) return refuse(`git ${sub}`)
	if (sub === "commit" && rest.includes("--amend")) return refuse("Amending a commit")
	if (sub === "branch" && rest.some((a) => /^-(d|D|-delete)$/.test(a))) return refuse("Deleting a branch")
	if (sub === "config" && rest.some((a) => a === "--global" || a === "--system"))
		return refuse("Changing git's global settings")
	if (sub === "tag" && rest.some((a) => /^-(d|-delete)$/.test(a))) return refuse("Deleting a tag")
	return APPROVE
}

function decideSegment(policy: CiRunPolicy, segment: string): CiDecision {
	const all = words(segment)
	// Leading environment assignments and call operators do not change the command.
	let start = 0
	while (start < all.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(all[start]) || all[start] === "&" || all[start] === "call")) {
		start++
	}
	const [head, ...args] = all.slice(start)
	if (!head) return APPROVE
	const name = path
		.basename(head)
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/, "")
	const unattended = policy.scope === "auto"
	if (name === "git") return decideGit(policy, args)
	if (name === "sudo" || name === "su" || name === "runas" || name === "doas") {
		return unattended ? deny("Commands that raise privileges are not allowed in a CI board run.") : ASK
	}
	if (name === "gh" || name === "az") {
		const verbs = args.filter((a) => !a.startsWith("-"))
		const readOnly =
			verbs.some((v) => READ_ONLY_CLI.has(v)) &&
			!verbs.some((v) => /^(merge|close|delete|update|create|edit|set|rerun|cancel)$/.test(v))
		return readOnly
			? APPROVE
			: unattended
				? deny(`\`${name} ${verbs.slice(0, 3).join(" ")}\` changes things outside the branch; report it instead.`)
				: ASK
	}
	if (FILE_COMMANDS.has(name)) {
		for (const arg of args) {
			if (arg.startsWith("-")) continue
			// cmd.exe switches (`rd /s /q dir`) are not paths.
			if (CMD_SWITCH_COMMANDS.has(name) && /^\/[A-Za-z?]{1,2}$/.test(arg)) continue
			if (/^(~|\$HOME|%USERPROFILE%|\$env:)/i.test(arg) || !isInside(policy.worktree, arg)) {
				return deny(`CI board runs may change files only in ${policy.worktree} (\`${name} ${arg}\`).`)
			}
		}
	}
	return APPROVE
}

function decideCommand(policy: CiRunPolicy, line: string): CiDecision {
	if (
		/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(ba|z|da)?sh\b|\biex\b|invoke-expression/i.test(
			line,
		)
	) {
		return policy.scope === "auto" ? deny("Running downloaded scripts is not allowed in a CI board run.") : ASK
	}
	for (const match of line.matchAll(/(?:^|[^0-9&<>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
		const target = match[1].replace(/^["']|["']$/g, "")
		if (target && !/^(nul|\/dev\/null|&\d)$/i.test(target) && !isInside(policy.worktree, target)) {
			return deny(`CI board runs may write files only in ${policy.worktree} (\`> ${target}\`).`)
		}
	}
	let decision: CiDecision = APPROVE
	for (const segment of splitSegments(line)) {
		const next = decideSegment(policy, segment)
		if (next.kind === "deny") return next
		if (next.kind === "ask") decision = ASK
	}
	return decision
}

/** What a CI board run's policy says about one tool call. */
export function decideCiTool(policy: CiRunPolicy, toolName: string, input: unknown): CiDecision {
	const unattended = policy.scope === "auto"
	const outside = (what: string) =>
		unattended ? deny(`${what} is not allowed in an unattended CI run; report it instead.`) : ASK
	let decision: CiDecision
	if (EDIT_TOOLS.has(toolName) || toolName === "apply_patch") {
		const paths = toolName === "apply_patch" ? patchPaths(input) : inputPaths(input)
		const bad = paths.find((p) => !isInside(policy.worktree, p) || insideGitDir(policy.worktree, p))
		decision = bad ? deny(`CI board runs may change files only in ${policy.worktree}, outside .git (${bad}).`) : APPROVE
	} else if (READ_TOOLS.has(toolName)) {
		const roots = [policy.worktree, ...policy.readRoots]
		const paths = inputPaths(input)
		decision = paths.every((p) => roots.some((root) => isInside(root, p)))
			? APPROVE
			: outside("Reading outside the working copy")
	} else if (COMMAND_TOOLS.has(toolName)) {
		decision = APPROVE
		for (const line of commandLines(input)) {
			const next = decideCommand(policy, line)
			if (next.kind === "deny") {
				decision = next
				break
			}
			if (next.kind === "ask") decision = ASK
		}
	} else if (PROCESS_TOOLS.has(toolName)) {
		decision = APPROVE
	} else if (toolName.includes("__")) {
		const tool = toolName.slice(toolName.indexOf("__") + 2)
		const devops = toolName.startsWith("plinycode-devops__")
		decision =
			devops && DEVOPS_READ_TOOLS.has(tool)
				? APPROVE
				: devops && unattended && Object.hasOwn(DEVOPS_UNATTENDED_REFUSALS, tool)
					? deny(DEVOPS_UNATTENDED_REFUSALS[tool])
					: outside(`The tool ${toolName}`)
	} else {
		decision = outside(`The tool ${toolName}`)
	}
	// A run the user started follows their settings for everything the policy does not refuse.
	return !unattended && decision.kind === "approve" ? ASK : decision
}

/** The policies of the CI board runs in progress, by conversation id. */
export class CiRunPolicies {
	private readonly policies = new Map<string, CiRunPolicy>()

	set(conversationId: string, policy: CiRunPolicy): void {
		this.policies.set(conversationId, policy)
	}

	get(conversationId: string | undefined): CiRunPolicy | undefined {
		return conversationId ? this.policies.get(conversationId) : undefined
	}

	delete(conversationId: string): void {
		this.policies.delete(conversationId)
	}
}
