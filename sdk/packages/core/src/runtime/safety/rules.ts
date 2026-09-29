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
		const scope = describeRuleScope(rule);
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
			rule,
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
