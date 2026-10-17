/**
 * How far delegation may go, as a host configures it (`CoreSessionConfig.subAgentLimits`).
 * Every field is optional: an unset or invalid value keeps the default.
 */
export interface SubAgentLimits {
	/**
	 * Levels of sub-agents below the root agent. The root is at depth 0; with
	 * the default of 1 its sub-agents cannot delegate, with 2 they can and
	 * theirs cannot. Clamped to `SUB_AGENT_MAX_DEPTH_CEILING`.
	 */
	maxDepth?: number;
	/** Sub-agent runs one parent may have in flight; the rest wait their turn. */
	maxConcurrent?: number;
	/**
	 * Iterations a sub-agent run gets. A configured agent's own `maxIterations`
	 * frontmatter takes precedence.
	 */
	maxIterations?: number;
}

/**
 * The root's sub-agents may not delegate: a chain of sub-agents multiplies
 * cost and context with nobody watching, and nothing a sub-agent does needs it.
 */
export const DEFAULT_SUB_AGENT_MAX_DEPTH = 1;
/** Sub-agent runs in flight per parent when the host sets no limit. */
export const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 3;
/** Iterations a sub-agent run gets when the host sets no limit of its own. */
export const DEFAULT_SUB_AGENT_MAX_ITERATIONS = 40;
/**
 * The deepest delegation the engine allows whatever the host asks for: with a
 * concurrency of N, depth 2 already allows N + N² runs at once.
 */
export const SUB_AGENT_MAX_DEPTH_CEILING = 2;

function positiveInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) {
		return undefined;
	}
	const whole = Math.floor(value);
	return whole >= 1 ? whole : undefined;
}

/** The limits with every field set: the host's values where valid, else the defaults. */
export function resolveSubAgentLimits(
	limits: SubAgentLimits | undefined,
): Required<SubAgentLimits> {
	return {
		maxDepth: Math.min(
			positiveInteger(limits?.maxDepth) ?? DEFAULT_SUB_AGENT_MAX_DEPTH,
			SUB_AGENT_MAX_DEPTH_CEILING,
		),
		maxConcurrent:
			positiveInteger(limits?.maxConcurrent) ??
			DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
		maxIterations:
			positiveInteger(limits?.maxIterations) ??
			DEFAULT_SUB_AGENT_MAX_ITERATIONS,
	};
}
