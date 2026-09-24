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

export function formatRulesForSystemPrompt(
	rules: ReadonlyArray<RuleConfig>,
): string {
	if (rules.length === 0) {
		return "";
	}

	const renderedRules = rules
		.map((rule) => {
			const scope = describeRuleScope(rule);
			return scope
				? `## ${rule.name}\n_${scope}_\n\n${rule.instructions}`
				: `## ${rule.name}\n${rule.instructions}`;
		})
		.join("\n\n");
	return `\n\n# Rules\n${renderedRules}`;
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
): RuleConfig[] {
	const snapshot = watcher.getSnapshot("rule");
	return [...snapshot.values()]
		.filter((record) => !ruleFilter || ruleFilter(record.filePath))
		.map((record) => record.item as RuleConfig)
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
