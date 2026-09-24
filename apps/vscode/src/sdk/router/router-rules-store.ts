/**
 * Where the FreeAuto rules files live, and how they are created and re-read.
 *
 * One global file per profile, plus an optional workspace file shared by all
 * profiles:
 *   - global:    <data dir>/pliny-free-auto.md          (default profile)
 *                <data dir>/pliny-free-auto.<profile>.md (fast, smart, ...)
 *   - workspace: <workspace>/.cline/pliny-free-auto.md
 *
 * Rules are cached and re-read only when a file's mtime changes, so routing a
 * call costs no I/O in the common case. Every failure degrades to the built-in
 * defaults; a rules file must never be able to block a turn.
 */

import { PLINY_FREE_AUTO_PROFILES } from "@plinycode/llms"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { resolveDataDir } from "../legacy-state-reader"
import { defaultRules, mergeRules, parseRulesMarkdown, ROUTER_RULES_FILENAME, rulesFilenameForProfile } from "./router-rules"
import type { RouterRules } from "./router-types"

/** Absolute path of a profile's global rules file. */
export function globalRulesPath(dataDir?: string, profile = "default"): string {
	return path.join(resolveDataDir(dataDir), rulesFilenameForProfile(profile))
}

/** Absolute path of a workspace's optional rules file. */
export function workspaceRulesPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".cline", ROUTER_RULES_FILENAME)
}

interface CacheEntry {
	mtimeMs: number
	rules: RouterRules
}

const cache = new Map<string, CacheEntry>()

/** Drop cached rules. Tests and the "reload rules" path use this. */
export function clearRulesCache(): void {
	cache.clear()
}

async function readRulesFile(filePath: string, profile: string): Promise<RouterRules | undefined> {
	let stat: Awaited<ReturnType<typeof fs.stat>>
	try {
		stat = await fs.stat(filePath)
	} catch {
		// Missing file is the normal case for the workspace override.
		cache.delete(filePath)
		return undefined
	}

	const cacheKey = `${profile}\0${filePath}`
	const cached = cache.get(cacheKey)
	if (cached && cached.mtimeMs === stat.mtimeMs) {
		return cached.rules
	}

	try {
		const markdown = await fs.readFile(filePath, "utf8")
		const rules = parseRulesMarkdown(markdown, profile)
		cache.set(cacheKey, { mtimeMs: stat.mtimeMs, rules })
		return rules
	} catch (error) {
		Logger.warn(`[FreeAuto] Failed to read rules file ${filePath}: ${error}`)
		return undefined
	}
}

/**
 * Effective rules for a session: the profile's global file (or its built-in
 * defaults) with the workspace file merged over it.
 */
export async function loadRouterRules(options?: {
	workspaceRoot?: string
	dataDir?: string
	profile?: string
}): Promise<RouterRules> {
	const profile = options?.profile ?? "default"
	const global = (await readRulesFile(globalRulesPath(options?.dataDir, profile), profile)) ?? defaultRules(profile)
	if (!options?.workspaceRoot) {
		return global
	}
	const workspace = await readRulesFile(workspaceRulesPath(options.workspaceRoot), profile)
	return mergeRules(global, workspace)
}

/**
 * Write a profile's documented rules file if none exists. Returns the path so a
 * caller can open it. Never throws.
 */
export async function initialiseDefaultRulesFile(dataDir?: string, profile = "default"): Promise<string | undefined> {
	const filePath = globalRulesPath(dataDir, profile)
	try {
		await fs.access(filePath)
		return filePath
	} catch {
		// Not there yet — fall through and create it.
	}
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, renderDefaultRulesMarkdown(profile), "utf8")
		Logger.log(`[FreeAuto] Created default rules file at ${filePath}`)
		return filePath
	} catch (error) {
		Logger.warn(`[FreeAuto] Failed to create rules file ${filePath}: ${error}`)
		return undefined
	}
}

/** Create any missing profile rules file. Never throws. */
export async function initialiseAllRulesFiles(dataDir?: string): Promise<void> {
	for (const { profile } of PLINY_FREE_AUTO_PROFILES) {
		await initialiseDefaultRulesFile(dataDir, profile)
	}
}

const PROFILE_BLURBS: Record<string, string> = {
	default:
		"This is the **default** profile (the `FreeAuto (router)` model): heuristic routes, with reasoning\nswitched per route.",
	fast: "This is the **fast** profile (the `FreeAuto · fast` model): the same routes, with reasoning switched\noff everywhere it can be.",
	smart: "This is the **smart** profile (the `FreeAuto · smart` model): the default routes plus the\nclassifier, which picks the tier and whether to think once per turn.",
}

/**
 * The starter rules document. The prose is deliberately substantial: it is both
 * the user's documentation and, when the classifier is enabled, the guidance
 * handed to the classifying model.
 */
export function renderDefaultRulesMarkdown(profile = "default"): string {
	const rules = defaultRules(profile)
	const poolLines = rules.pool.map((id) => `  - ${id}`).join("\n")
	const fence = "```"
	const blurb = PROFILE_BLURBS[profile] ?? `This is the **${profile}** profile.`

	return `# PlinyCode FreeAuto routing rules

${blurb} Each FreeAuto model in the picker has its own file like
this one, so strategies can be compared side by side; every routed call is
logged to \`pliny-free-auto-calls.jsonl\` next to it.

FreeAuto picks a free, self-hosted Pliny model for every request and moves to a
backup when one fails. Edit this file to change those choices; it is re-read
automatically whenever you save it, so there is no need to restart.

Only free \`snps-provider*\` models can be routed to. Any other id in this file
is ignored, so routing can never start spending money by accident.

## How a model is chosen

1. The first route whose conditions all match wins.
2. Its \`use\` list becomes the candidate order; the rest of \`pool\` follows as
   backups.
3. Models currently benched after repeated failures are skipped.
4. Models whose context window is too small for the request are skipped.
5. The first remaining candidate runs the call.

If a call fails before producing any output, the next candidate takes over and
you get a note in the chat. If it fails after producing output, the turn is
retried in place with the next model, continuing rather than restarting.

## Route conditions

| Condition | Meaning |
| --- | --- |
| \`mode\` | \`plan\` or \`act\` |
| \`minEstimatedTokens\` | request is at least this large |
| \`maxEstimatedTokens\` | request is at most this large |
| \`maxPromptChars\` | your message is at most this long |
| \`promptRegex\` | case-insensitive pattern matched against your message |
| \`subAgent\` | \`true\` to match only calls made by a spawned sub-agent, \`false\` for only the main agent |

## Route settings

| Setting | Meaning |
| --- | --- |
| \`effort\` | \`quick\` switches reasoning off, \`think\` switches it on; unset keeps each model's default |
| \`reasoningEffort\` | \`low\`, \`medium\` or \`high\`, sent when a \`think\` route turns reasoning on |
| \`tier\` | \`quick\`, \`code\`, \`reason\` or \`huge\`: the classifier verdict this route serves |

Effort only changes models whose reasoning switch was measured by the thinking
probe (see \`docs/pliny-free-auto-thinking.md\`); a switch a backend does not
understand would fail the call, so every other model keeps its default.

## Other settings

- \`pool\` — every model FreeAuto may use, best first.
- \`utility\` — models for background jobs: prompt classification, conversation
  summaries, and commit messages.
- \`classifier.enabled\` — when on, a small model reads your message once per
  turn and returns a tier and whether to think. The first route tagged with
  that tier is used (its size and \`subAgent\` conditions must still hold), and
  the think verdict overrides the route's \`effort\`. Costs one extra fast call
  per turn; any failure or timeout falls back to the routes above.
- \`health\` — how quickly a failing model is benched, how many failovers a
  single turn allows, and how long to wait before treating a silent stream as
  stalled.
- \`contextMarginRatio\` — safety factor when checking whether a request fits a
  model's context window.
- \`sticky\` — keep the model chosen at the start of a turn for the rest of it.

## Guidance for the classifier

Prefer the coding-specialised model for writing or changing code. Prefer a
large-context model when the conversation is long or many files are attached.
Prefer a fast small model for short factual questions. When in doubt, choose the
default route.

${fence}yaml
version: 1

pool:
${poolLines}

utility:
  classifier: ${rules.utility.classifier}
  summarizer: ${rules.utility.summarizer}
  commit: ${rules.utility.commit}

classifier:
  enabled: ${rules.classifier.enabled}
  timeoutMs: ${rules.classifier.timeoutMs}
  maxPromptChars: ${rules.classifier.maxPromptChars}

health:
  cooldownMs: ${rules.health.cooldownMs}
  failuresBeforeCooldown: ${rules.health.failuresBeforeCooldown}
  maxFailoversPerTurn: ${rules.health.maxFailoversPerTurn}
  firstTokenTimeoutMs: ${rules.health.firstTokenTimeoutMs}
  stallTimeoutMs: ${rules.health.stallTimeoutMs}

contextMarginRatio: ${rules.contextMarginRatio}
sticky: ${rules.sticky}

routes:
${rules.routes.map((route) => renderRouteYaml(route)).join("\n")}
${fence}
`
}

function renderRouteYaml(route: RouterRules["routes"][number]): string {
	const lines = [`  - name: ${route.name}`]
	if (route.tier) {
		lines.push(`    tier: ${route.tier}`)
	}
	if (route.effort) {
		lines.push(`    effort: ${route.effort}`)
	}
	if (route.reasoningEffort) {
		lines.push(`    reasoningEffort: ${route.reasoningEffort}`)
	}
	if (route.when && Object.keys(route.when).length > 0) {
		lines.push("    when:")
		if (route.when.mode) {
			lines.push(`      mode: ${route.when.mode}`)
		}
		if (route.when.minEstimatedTokens !== undefined) {
			lines.push(`      minEstimatedTokens: ${route.when.minEstimatedTokens}`)
		}
		if (route.when.maxEstimatedTokens !== undefined) {
			lines.push(`      maxEstimatedTokens: ${route.when.maxEstimatedTokens}`)
		}
		if (route.when.maxPromptChars !== undefined) {
			lines.push(`      maxPromptChars: ${route.when.maxPromptChars}`)
		}
		if (route.when.promptRegex) {
			// Single-quoted: YAML double quotes treat the regex's backslashes as escapes.
			lines.push(`      promptRegex: '${route.when.promptRegex.replace(/'/g, "''")}'`)
		}
		if (route.when.subAgent !== undefined) {
			lines.push(`      subAgent: ${route.when.subAgent}`)
		}
	}
	lines.push("    use:")
	for (const id of route.use) {
		lines.push(`      - ${id}`)
	}
	return lines.join("\n")
}
