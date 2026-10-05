import type { WorkspaceContext } from "../extensions/context";
import { isClineProvider } from "../providers/utils";
import type { WorkspaceInfo } from "../session/workspace";
import { formatGitSnapshotForEnv, type GitSnapshot } from "./git-snapshot";
import { DEFAULT_CLINE_SYSTEM_PROMPTS } from "./system";

const WORKSPACE_CONFIGURATION_MARKER = "# Workspace Configuration";

/**
 * Explains the <user_input mode="..."> wrapper and <mode_notice> elements the
 * runtime stamps on user messages (prepareTurnInput / formatUserInputBlock).
 * Every host that sends through the SDK runtime produces those tags, so every
 * host's system prompt must explain them: without this section the model has
 * no idea what the attribute means, and a mid-conversation mode switch is an
 * invisible system-prompt swap it cannot diff. Included for BOTH modes, since
 * after a switch the transcript still contains messages tagged with the other
 * mode.
 */
export const MODE_TAG_INSTRUCTIONS = `# Plan / Act Modes

User messages arrive wrapped in a <user_input mode="..."> tag. The mode attribute is the interaction mode the user was in when they sent that message: "plan" means plan-mode constraints applied (explore, analyze, and write the plan -- no edits except markdown plan files, no state-changing commands), "ask" means ask-mode constraints applied (answer the question -- no file edits at all, no state-changing commands), while "act" (or "yolo") means implementation was allowed. If the mode attribute changes between messages, the user switched modes -- the newest message's mode is what governs right now, regardless of what earlier messages allowed. A <mode_notice> block inside a message marks exactly when such a switch happened.`;

/**
 * Plan-mode behavioral contract, appended when the session mode is "plan".
 * The plan is written as markdown files (a root plans/<slug>/PLAN.md plus
 * optional sub-files) so the user can edit it and act mode can execute it
 * from disk. run_commands intentionally stays available in plan mode -- it
 * is essential for read-only investigation -- so the contract must spell out
 * that it is inspection-only there. Prompting is the first line of defense;
 * the plan-mode command-guard hook (registered by the core runtime builder
 * for plan-mode sessions) is the hard backstop that rejects file-editing
 * run_commands calls and non-markdown editor writes with a tool error before
 * approval or execution.
 */
const PLAN_MODE_INSTRUCTIONS_BASE = `# Plan Mode

You are in Plan mode. Your role is to explore, analyze, and write a plan -- not to execute it.

- Read files, search the codebase, and gather context to understand the problem
- Ask clarifying questions when requirements are ambiguous
- Explain tradeoffs between different approaches when they exist
- Do NOT edit source, config, or any other non-markdown file, run destructive commands, or make any changes
- Do NOT implement anything -- focus on understanding and alignment first

## Writing the plan

Write the plan as markdown files with the editor tool, using workspace-relative paths under plans/<short-kebab-slug>/:

1. Create the root file plans/<slug>/PLAN.md first. It coordinates the whole plan: the goal, the relevant context, the ordered steps or phases, how to verify the result, and links to any sub-files.
2. When a part of the plan is large or independent, put it in its own file in the same folder (for example plans/<slug>/01-backend.md) and link it from PLAN.md. A small plan needs only PLAN.md.
3. When the user gives feedback on the plan, update the existing plan files instead of starting a new folder.
4. End your turn with a short summary that names the root file (plans/<slug>/PLAN.md). Do not paste the whole plan into the chat.

In plan mode the editor tool only accepts markdown (.md) paths; writes to any other file are rejected with a tool error. If you are only answering a question or asking for clarification, you do not need to write a plan file.

The run_commands tool remains available in plan mode strictly for read-only inspection -- listing files, searching (grep), reading configs, inspecting git history and diffs, checking tool versions, and the like. Never use it to change anything: no creating, modifying, or deleting files, no writing scripts that make changes, and no state-changing commands (installs, migrations, database or schema changes, container commands that mutate state, etc.). File-editing commands (rm/mv/cp, in-place edits like sed -i, output redirection to files outside /tmp, git commands that change the working tree, package installs) are hard-blocked in plan mode: they are not executed and return a tool error instead, so do not attempt them. If the task requires a mutation, put it in the plan; it happens only after the user switches to act mode.`;

export const PLAN_MODE_INSTRUCTIONS = `${PLAN_MODE_INSTRUCTIONS_BASE}

Once the user has reviewed your plan and explicitly approved it in a follow-up message, use the switch_to_act_mode tool to switch to act mode and begin implementation. Calling switch_to_act_mode immediately starts execution, so never call it in the same turn you present a plan and never treat the original task request as approval -- end your turn after presenting the plan and wait for the user's response.`;

/**
 * Plan-mode contract for hosts that do NOT expose the switch_to_act_mode tool
 * (the VS Code extension, matching the legacy extension's behavior). The model
 * must direct the user to flip the Plan/Act toggle instead of calling a tool
 * that does not exist in its toolset.
 */
export const PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH = `${PLAN_MODE_INSTRUCTIONS_BASE}

Once you have written your plan, end your turn and wait for the user's response. The user may edit the plan files before running them. You do NOT have the ability to switch to act mode yourself -- the user starts execution with the Execute plan button or the Plan/Act toggle once they are satisfied with the plan. If the task requires tools that are only available in act mode, ask the user to "toggle to Act mode" (use those words).`;

/**
 * Ask-mode behavioral contract, appended when the session mode is "ask".
 * Ask mode answers questions about the code and never changes a file. As in
 * plan mode, run_commands stays available for read-only investigation, and
 * the ask-mode command-guard hook (registered by the core runtime builder for
 * ask-mode sessions) is the hard backstop that rejects file-editing
 * run_commands calls and every editor or apply_patch write.
 */
export const ASK_MODE_INSTRUCTIONS = `# Ask Mode

You are in Ask mode. Your role is to answer the user's question -- not to change anything.

- Read files, search the codebase, and gather the context you need to answer accurately
- Answer directly and concretely, citing the files and lines your answer is based on
- When the answer involves a code change, show it in your reply as a code block or a diff; do not apply it
- Ask a clarifying question when the request is ambiguous
- Do NOT create, edit, or delete any file, markdown files included, and do NOT make any other change

File edits are blocked in ask mode: the file-writing tools are not available, and any attempt to write a file is rejected with a tool error.

The run_commands tool remains available in ask mode strictly for read-only inspection -- listing files, searching (grep), reading configs, inspecting git history and diffs, checking tool versions, and the like. Never use it to change anything: no creating, modifying, or deleting files, no writing scripts that make changes, and no state-changing commands (installs, migrations, database or schema changes, container commands that mutate state, etc.). File-editing commands (rm/mv/cp, in-place edits like sed -i, output redirection to files outside /tmp, git commands that change the working tree, package installs) are hard-blocked in ask mode: they are not executed and return a tool error instead, so do not attempt them.

You do NOT have the ability to switch modes yourself. If the user asks for a change to be made, explain what you would change and ask them to "toggle to Act mode" (use those words) to apply it.`;

function redactRemoteUrlCredentials(remote: string): string {
	const schemeEnd = remote.indexOf("://");
	if (schemeEnd < 1) return remote;

	const authorityStart = schemeEnd + 3;
	let authorityEnd = authorityStart;
	while (authorityEnd < remote.length) {
		const char = remote[authorityEnd];
		if (
			char === "/" ||
			char === "?" ||
			char === "#" ||
			char.charCodeAt(0) <= 32
		) {
			break;
		}
		authorityEnd++;
	}

	const userInfoEnd = remote.lastIndexOf("@", authorityEnd - 1);
	if (userInfoEnd < authorityStart) return remote;
	return remote.slice(0, authorityStart) + remote.slice(userInfoEnd + 1);
}

export function processWorkspaceInfo(info: WorkspaceInfo): string {
	return JSON.stringify(
		{
			workspaces: {
				[info.rootPath]: {
					hint: info.hint,
					associatedRemoteUrls: info.associatedRemoteUrls?.map(
						redactRemoteUrlCredentials,
					),
					latestGitCommitHash: info.latestGitCommitHash,
					latestGitBranchName: info.latestGitBranchName,
				},
			},
		},
		null,
		2,
	);
}

function buildWorkspaceMetadata(
	rootPath: string,
	workspaceName?: string,
	metadata?: string,
): string {
	if (metadata?.trim()?.includes(WORKSPACE_CONFIGURATION_MARKER)) {
		return metadata.trim();
	}
	const body =
		metadata ||
		JSON.stringify(
			{
				workspaces: {
					[rootPath]: {
						hint: workspaceName || rootPath.split("/").at(-1) || rootPath,
					},
				},
			},
			null,
			2,
		);
	return `\n${WORKSPACE_CONFIGURATION_MARKER}\n${body}`;
}

// The <env> block's entries are numbered; git follows the working directory.
const GIT_ENV_ENTRY_NUMBER = 5;

/**
 * The git data for the <env> block. A host that gathered a snapshot passes it
 * as `gitSnapshot`; one that only has the WorkspaceInfo git fields gets the
 * branch and HEAD from those, so both feed the same block for every provider.
 */
function resolveGitSnapshot(
	options: ClineSystemPromptOptions,
): GitSnapshot | undefined {
	if (options.gitSnapshot) {
		return options.gitSnapshot;
	}
	const branch = options.latestGitBranchName?.trim();
	const head = options.latestGitCommitHash?.trim().slice(0, 7);
	if (!branch && !head) {
		return undefined;
	}
	return { ...(branch ? { branch } : {}), ...(head ? { head } : {}) };
}

/**
 * Options for building the Cline system prompt.
 *
 * Extends WorkspaceContext so callers can spread an ExtensionContext.workspace
 * directly. `workspaceRoot` is accepted as an alias for `rootPath` to support
 * existing call sites that set it explicitly.
 */
export interface ClineSystemPromptOptions
	extends Omit<WorkspaceContext, "rootPath"> {
	/**
	 * Workspace root path. Accepts either `rootPath` (from WorkspaceContext/WorkspaceInfo)
	 * or `workspaceRoot` (legacy alias) — whichever is provided will be used.
	 */
	rootPath?: string;
	/** Alias for rootPath — kept for backwards compatibility with existing call sites */
	workspaceRoot?: string;
	/** Per-request system prompt override */
	overridePrompt?: string;
	/** Provider ID — used to gate Cline-specific metadata injection */
	providerId?: string;
	/**
	 * Whether the host exposes the switch_to_act_mode tool in plan mode.
	 * Defaults to true (CLI behavior). Hosts that require the user to flip the
	 * Plan/Act toggle themselves (the VS Code extension) set this to false so
	 * the plan-mode contract directs the model to ask the user instead of
	 * calling a tool that is not in its toolset.
	 */
	planModeSwitchTool?: boolean;
}

export function buildClineSystemPrompt(
	options: ClineSystemPromptOptions,
): string {
	const {
		ide = "Terminal Shell",
		mode,
		platform = "unknown",
		workspaceName,
		metadata,
		rules,
		overridePrompt,
		providerId,
		planModeSwitchTool = true,
	} = options;
	const workspaceRoot = options.workspaceRoot ?? options.rootPath ?? "";
	const isCline = isClineProvider(providerId || "");

	if (overridePrompt?.trim()) {
		const trimmed = overridePrompt.trim();
		if (
			isCline &&
			metadata?.trim() &&
			!trimmed.includes(WORKSPACE_CONFIGURATION_MARKER)
		) {
			return `${trimmed}\n\n${buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)}`.trim();
		}
		return trimmed;
	}

	const basePrompt =
		mode === "yolo"
			? DEFAULT_CLINE_SYSTEM_PROMPTS.YOLO
			: DEFAULT_CLINE_SYSTEM_PROMPTS.ACT;

	// Mode semantics ride in the rules slot so every host emits them without
	// composing its own copy. Order matches what the CLI historically built by
	// hand (caller rules, then the mode-tag explanation, then the plan-mode
	// contract), keeping CLI output byte-identical after the promotion.
	const effectiveRules = [
		rules,
		MODE_TAG_INSTRUCTIONS,
		mode === "plan"
			? planModeSwitchTool
				? PLAN_MODE_INSTRUCTIONS
				: PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH
			: mode === "ask"
				? ASK_MODE_INSTRUCTIONS
				: undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	// Branch names, paths and commit subjects are repository content. They go
	// in last and through a function, so they are neither read as replacement
	// patterns ("$&") nor scanned for the other placeholders.
	const gitEnv = formatGitSnapshotForEnv(
		resolveGitSnapshot(options),
		GIT_ENV_ENTRY_NUMBER,
	);

	return basePrompt
		.replace("{{PLATFORM_NAME}}", platform)
		.replace("{{CWD}}", workspaceRoot)
		.replace("{{CURRENT_DATE}}", new Date().toLocaleDateString())
		.replace("{{IDE_NAME}}", ide)
		.replace(
			"{{CLINE_METADATA}}",
			isCline
				? buildWorkspaceMetadata(workspaceRoot, workspaceName, metadata)
				: "",
		)
		.replace("{{CLINE_RULES}}", effectiveRules)
		.replace("{{GIT_SNAPSHOT}}", () => (gitEnv ? `\n${gitEnv}` : ""))
		.trim();
}
