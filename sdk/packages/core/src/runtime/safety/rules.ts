import type {
	RuleConfig,
	UserInstructionConfigWatcher,
} from "../../extensions/config/user-instruction-config-loader";

/**
 * Host-supplied predicate deciding whether the rule loaded from `filePath` may
 * reach the system prompt. Lets a host (e.g. the VS Code Rules panel) disable a
 * rule file it does not own without editing the file.
 */
export type RuleFileFilter = (filePath: string) => boolean;

export function isRuleEnabled(rule: RuleConfig): boolean {
	return rule.disabled !== true;
}

function toPatternList(value: unknown): string[] {
	const items = Array.isArray(value) ? value : [value];
	return items
		.filter((item): item is string => typeof item === "string")
		.flatMap((item) => item.split(","))
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/**
 * Describe a rule's activation scope from the frontmatter conventions of the
 * tools that write rule files, so the model can apply scoped guidance only
 * where it belongs:
 *
 * - Cline `paths:` and GitHub Copilot `applyTo:` — file globs
 * - Cursor `globs:` + `alwaysApply:` — file globs, or `description:` for an
 *   "apply when relevant" rule
 */
export function describeRuleScope(rule: RuleConfig): string | undefined {
	const frontmatter = rule.frontmatter ?? {};
	if (frontmatter.alwaysApply === true) {
		return undefined;
	}
	const patterns = [
		...toPatternList(frontmatter.paths),
		...toPatternList(frontmatter.applyTo),
		...toPatternList(frontmatter.globs),
	].filter((pattern) => pattern !== "**" && pattern !== "**/*");
	if (patterns.length > 0) {
		return `Applies only when working with files matching: ${patterns.map((pattern) => `\`${pattern}\``).join(", ")}`;
	}
	const description =
		typeof frontmatter.description === "string"
			? frontmatter.description.trim()
			: "";
	if (frontmatter.alwaysApply === false && description) {
		return `Apply only when relevant: ${description}`;
	}
	return undefined;
}

/** A rule plus the file it was loaded from, when the caller knows it. */
export type RuleForPrompt = RuleConfig & { filePath?: string };

function isCursorRuleFile(filePath: string | undefined): boolean {
	return !!filePath && /[\\/]\.cursor[\\/]rules[\\/]/.test(filePath);
}

/**
 * Scope of a rule in Cursor's `.cursor/rules` folder that describeRuleScope
 * left unscoped. Cursor applies such a file on every request only with
 * `alwaysApply: true`; with just a description the agent pulls it in when
 * relevant, and with neither ("Manual") only when the user @-mentions it.
 * Inlining the last two put rules Cursor itself would leave out into every
 * request.
 */
function describeCursorRuleScope(rule: RuleForPrompt): string | undefined {
	const frontmatter = rule.frontmatter ?? {};
	if (!isCursorRuleFile(rule.filePath) || frontmatter.alwaysApply === true) {
		return undefined;
	}
	const description =
		typeof frontmatter.description === "string"
			? frontmatter.description.trim()
			: "";
	return description
		? `Apply only when relevant: ${description}`
		: "Manual Cursor rule: read it when the user mentions it or the task is about it";
}

/**
 * Pushes a rule body's markdown headings two levels down, so they nest under
 * the rule's own `## name` heading. A body opening with `# Title` otherwise
 * reads as a new top-level section of the system prompt, outside `# Rules`
 * (and the chat's context row counted only the rules before it). Fenced code
 * is left alone: `# comment` lines in shell snippets are not headings.
 */
export function nestRuleHeadings(body: string): string {
	let fence: string | undefined;
	return body
		.split("\n")
		.map((line) => {
			if (fence) {
				const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
				if (
					close &&
					close[1][0] === fence[0] &&
					close[1].length >= fence.length
				) {
					fence = undefined;
				}
				return line;
			}
			const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
			if (open) {
				fence = open[1];
				return line;
			}
			return line.replace(
				/^( {0,3})(#{1,6})(?=\s|$)/,
				(_match, indent: string, hashes: string) =>
					`${indent}${"#".repeat(Math.min(6, hashes.length + 2))}`,
			);
		})
		.join("\n");
}

/** Longest body one always-on rule may put in the system prompt. */
export const MAX_RULE_CHARS = 12_000;
/** Budget for all always-on rule bodies together. */
export const MAX_RULES_TOTAL_CHARS = 40_000;

/**
 * Renders rules for the system prompt, which is resent with every request.
 *
 * - Always-on rules are inlined, each capped at MAX_RULE_CHARS and all of them
 *   at MAX_RULES_TOTAL_CHARS. What does not fit is listed by path instead.
 * - Scoped rules (file globs, or Cursor's "apply when relevant") are listed by
 *   name, scope and path, and the model reads one when its scope applies, the
 *   way Cursor treats agent-requested rules. Inlining them put guidance for
 *   files the task never touches into every request.
 * - Rules with no known file stay inline, since the model could not read them.
 * - Files in `.cursor/rules` follow Cursor's rule types: only
 *   `alwaysApply: true` is inlined, the rest are listed (describeCursorRuleScope).
 * - Inlined bodies have their headings nested under the rule's own heading
 *   (nestRuleHeadings).
 */
export function formatRulesForSystemPrompt(
	rules: ReadonlyArray<RuleForPrompt>,
): string {
	if (rules.length === 0) {
		return "";
	}

	const inline: string[] = [];
	const onDemand: string[] = [];
	let remaining = MAX_RULES_TOTAL_CHARS;
	for (const rule of rules) {
		const scope = describeRuleScope(rule) ?? describeCursorRuleScope(rule);
		if (scope && rule.filePath) {
			onDemand.push(`- **${rule.name}** (${scope}): \`${rule.filePath}\``);
			continue;
		}
		if (remaining <= 0 && rule.filePath) {
			onDemand.push(
				`- **${rule.name}** (not inlined: the rules budget is used up): \`${rule.filePath}\``,
			);
			continue;
		}
		const body = capRuleBody(
			{ ...rule, instructions: nestRuleHeadings(rule.instructions) },
			Math.max(0, Math.min(MAX_RULE_CHARS, remaining)),
		);
		remaining -= body.length;
		inline.push(
			scope
				? `## ${rule.name}\n_${scope}_\n\n${body}`
				: `## ${rule.name}\n${body}`,
		);
	}

	if (onDemand.length > 0) {
		inline.push(
			[
				"## Rules to read when they apply",
				"These rule files are not included above. When one applies to the files or the kind of work in front of you, read it with read_files and follow it.",
				...onDemand,
			].join("\n"),
		);
	}
	return `\n\n# Rules\n${inline.join("\n\n")}`;
}

function capRuleBody(rule: RuleForPrompt, limit: number): string {
	const body = rule.instructions;
	if (body.length <= limit) {
		return body;
	}
	const omitted = body.length - limit;
	const where = rule.filePath ? ` Read the rest in \`${rule.filePath}\`.` : "";
	return `${body.slice(0, limit)}\n\n[Rule truncated: ${omitted} more characters.${where}]`;
}

export function mergeRulesForSystemPrompt(
	primaryRules?: string,
	additionalRules?: string,
): string | undefined {
	const primary = primaryRules?.trim();
	const additional = additionalRules?.trim();
	if (primary && additional) {
		return `${primary}\n\n${additional}`;
	}
	return primary || additional || undefined;
}

export function listEnabledRulesFromWatcher(
	watcher: UserInstructionConfigWatcher,
	ruleFilter?: RuleFileFilter,
): RuleForPrompt[] {
	const snapshot = watcher.getSnapshot("rule");
	return [...snapshot.values()]
		.filter((record) => !ruleFilter || ruleFilter(record.filePath))
		.map((record) => ({
			...(record.item as RuleConfig),
			filePath: record.filePath,
		}))
		.filter(isRuleEnabled)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRulesForSystemPromptFromWatcher(
	watcher: UserInstructionConfigWatcher,
	ruleFilter?: RuleFileFilter,
): string {
	return formatRulesForSystemPrompt(
		listEnabledRulesFromWatcher(watcher, ruleFilter),
	);
}
