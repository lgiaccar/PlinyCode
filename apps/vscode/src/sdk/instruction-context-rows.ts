/**
 * One chat row per turn that says which rules and skills the model was given.
 *
 * Rules go into the system prompt and skills into the `skills` tool's
 * description, so until now nothing in the chat showed whether a workspace's
 * `AGENTS.md`, `.cursor/rules` or `.github/skills` had actually been loaded:
 * the only way to find out was to notice the model ignoring them. This reads
 * the request the engine is about to send and reports what it carries, and it
 * reports again only when the set changes, so a long turn stays one row.
 */

import type { CoreSessionConfig } from "@plinycode/core"
import type { AgentBeforeModelContext, AgentModelRequest } from "@plinycode/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"

export interface InstructionContextSummary {
	/** Names of rules whose body is in the system prompt. */
	inlineRules: string[]
	/** Names of rules listed by path for the model to read when they apply. */
	onDemandRules: string[]
	/** Skills the `skills` tool offers. */
	skills: string[]
	/** Characters the `# Rules` section adds to every request. */
	rulesChars?: number
	/** Characters the skill list adds to the `skills` tool description. */
	skillsChars?: number
	/** Characters the `# Memory` section adds to every request (docs/memory.md). */
	memoryChars?: number
}

const RULES_HEADING = "# Rules"
const MEMORY_HEADING = "# Memory"
const ON_DEMAND_HEADING = "## Rules to read when they apply"

/**
 * Blanks out fenced code blocks, keeping every offset: a `# comment` line in a
 * rule's shell snippet is not a heading.
 */
function maskFencedCode(text: string): string {
	return text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[`~]*[ \t]*$/gm, (block) => block.replace(/[^\n]/g, " "))
}

/**
 * The `# Rules` section, up to the next top-level heading, with fenced code
 * blanked out. The engine nests each inlined rule's own headings below its
 * `## name`, so a `# Title` inside a rule does not end the section early, and
 * the only `## ` lines before the on-demand list are rule names.
 */
function topLevelSection(systemPrompt: string, heading: string): string | undefined {
	const masked = maskFencedCode(systemPrompt)
	const start = masked.indexOf(`\n${heading}\n`)
	if (start < 0) {
		return undefined
	}
	const body = masked.slice(start + heading.length + 2)
	const next = body.search(/\n# /)
	return next < 0 ? body : body.slice(0, next)
}

function rulesSection(systemPrompt: string): string | undefined {
	return topLevelSection(systemPrompt, RULES_HEADING)
}

/** What the request carries in terms of rules and skills. */
export function summarizeInstructionContext(request: AgentModelRequest): InstructionContextSummary {
	const summary: InstructionContextSummary = { inlineRules: [], onDemandRules: [], skills: [] }

	const section = rulesSection(request.systemPrompt ?? "")
	if (section) {
		const onDemandAt = section.indexOf(ON_DEMAND_HEADING)
		const inlinePart = onDemandAt < 0 ? section : section.slice(0, onDemandAt)
		const onDemandPart = onDemandAt < 0 ? "" : section.slice(onDemandAt + ON_DEMAND_HEADING.length)
		for (const match of inlinePart.matchAll(/^## (.+)$/gm)) {
			summary.inlineRules.push(match[1].trim())
		}
		for (const match of onDemandPart.matchAll(/^- \*\*(.+?)\*\*/gm)) {
			summary.onDemandRules.push(match[1].trim())
		}
		summary.rulesChars = section.length
	}

	// The memory files' own headings are nested below the section's, like a rule's.
	const memory = topLevelSection(request.systemPrompt ?? "", MEMORY_HEADING)
	if (memory) {
		summary.memoryChars = memory.length
	}

	const skillsTool = request.tools.find((tool) => tool.name === "skills")
	const available = skillsTool?.description.match(/Available skills: (.+?)\.?\s*$/)?.[1]
	if (available) {
		summary.skillsChars = available.length
		summary.skills = available
			.split(/;\s*/)
			.map((entry) => entry.replace(/\s*\(.*$/, "").trim())
			.filter(Boolean)
	}
	return summary
}

const MAX_NAMES = 5
/** Rough characters per token, enough for a "how big is this" hint. */
const CHARS_PER_TOKEN = 4

function nameList(names: string[]): string {
	const shown = names.slice(0, MAX_NAMES).map((name) => `\`${name}\``)
	const more = names.length - shown.length
	return more > 0 ? `${shown.join(", ")} +${more} more` : shown.join(", ")
}

/** ` (~6.7k tokens)`, or nothing when the size is unknown. */
function tokenHint(chars: number | undefined): string {
	if (!chars) {
		return ""
	}
	const tokens = Math.ceil(chars / CHARS_PER_TOKEN)
	const text = tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`
	return ` (~${text} tokens)`
}

/** The row's text, or undefined when there is nothing to report. */
export function formatInstructionContextRow(summary: InstructionContextSummary): string | undefined {
	const parts: string[] = []
	if (summary.inlineRules.length > 0) {
		parts.push(
			`${summary.inlineRules.length} rule${summary.inlineRules.length === 1 ? "" : "s"} in the prompt${tokenHint(summary.rulesChars)}: ${nameList(summary.inlineRules)}`,
		)
	}
	if (summary.onDemandRules.length > 0) {
		parts.push(
			`${summary.onDemandRules.length} rule${summary.onDemandRules.length === 1 ? "" : "s"} to read when relevant: ${nameList(summary.onDemandRules)}`,
		)
	}
	if (summary.skills.length > 0) {
		parts.push(
			`${summary.skills.length} skill${summary.skills.length === 1 ? "" : "s"}${tokenHint(summary.skillsChars)}: ${nameList(summary.skills)}`,
		)
	}
	if (summary.memoryChars) {
		parts.push(`memory${tokenHint(summary.memoryChars)}`)
	}
	if (parts.length === 0) {
		return "Context: no rules or skills were loaded for this workspace."
	}
	return `Context: ${parts.join(" · ")}`
}

export interface InstructionContextRowsDeps {
	emitRow: (message: ClineMessage) => void
	nextMessageTs: () => number
}

/**
 * Compose a `beforeModel` hook onto the session that emits the context row
 * for the root agent, the first time and whenever the loaded set changes.
 * Sub-agents inherit the hook but stay silent: their toolset differs and the
 * row would only repeat what the root already showed.
 */
export function installInstructionContextRows(config: CoreSessionConfig, deps: InstructionContextRowsDeps): CoreSessionConfig {
	let lastSignature: string | undefined
	const baseBeforeModel = config.hooks?.beforeModel
	config.hooks = {
		...(config.hooks ?? {}),
		beforeModel: async (context: AgentBeforeModelContext) => {
			const baseResult = await baseBeforeModel?.(context)
			if (baseResult?.stop || context.snapshot.parentAgentId) {
				return baseResult
			}
			const summary = summarizeInstructionContext(context.request)
			const signature = JSON.stringify(summary)
			if (signature !== lastSignature) {
				lastSignature = signature
				const text = formatInstructionContextRow(summary)
				if (text) {
					deps.emitRow({ ts: deps.nextMessageTs(), type: "say", say: "info", text, partial: false })
				}
			}
			return baseResult
		},
	}
	return config
}
