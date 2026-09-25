import * as yaml from "js-yaml"
import { describe, expect, it } from "vitest"
import {
	defaultPool,
	defaultRules,
	extractGuidance,
	extractYamlBlock,
	mergeRules,
	normalizeRules,
	parseRulesMarkdown,
	rulesFilenameForProfile,
	workspaceRulesFilenameForProfile,
} from "./router-rules"
import { renderDefaultRulesMarkdown } from "./router-rules-store"

const FENCE = "```"

function markdown(yamlBody: string, prose = "Guidance for the classifier."): string {
	return `# Rules\n\n${prose}\n\n${FENCE}yaml\n${yamlBody}\n${FENCE}\n`
}

describe("defaultPool", () => {
	it("contains only free self-hosted models", () => {
		const pool = defaultPool()
		expect(pool.length).toBeGreaterThan(5)
		expect(pool.every((id) => id.startsWith("snps-provider"))).toBe(true)
	})

	it("has no duplicates", () => {
		const pool = defaultPool()
		expect(new Set(pool).size).toBe(pool.length)
	})

	it("leads the balance pool with paid models and keeps every free one behind them", () => {
		const balance = defaultPool("balance")
		const free = defaultPool()
		expect(balance[0]).toBe("snps-aws-bedrock/global.anthropic.claude-sonnet-5")
		expect(balance.slice(balance.length - free.length)).toEqual(free)
		expect(new Set(balance).size).toBe(balance.length)
		expect(balance.filter((id) => !id.startsWith("snps-provider")).length).toBeGreaterThanOrEqual(3)
	})

	it("keeps the free profiles' pools free", () => {
		for (const profile of ["default", "fast", "smart"]) {
			expect(
				defaultPool(profile).every((id) => id.startsWith("snps-provider")),
				profile,
			).toBe(true)
		}
	})
})

describe("rules file names", () => {
	it("gives BalanceAuto its own global and workspace files", () => {
		expect(rulesFilenameForProfile("balance")).toBe("pliny-balance-auto.md")
		expect(workspaceRulesFilenameForProfile("balance")).toBe("pliny-balance-auto.md")
	})

	it("shares one workspace file across the FreeAuto profiles", () => {
		expect(rulesFilenameForProfile("default")).toBe("pliny-free-auto.md")
		expect(rulesFilenameForProfile("fast")).toBe("pliny-free-auto.fast.md")
		expect(workspaceRulesFilenameForProfile("default")).toBe("pliny-free-auto.md")
		expect(workspaceRulesFilenameForProfile("fast")).toBe("pliny-free-auto.md")
		expect(workspaceRulesFilenameForProfile("smart")).toBe("pliny-free-auto.md")
	})
})

describe("extractYamlBlock / extractGuidance", () => {
	it("extracts the first yaml fence", () => {
		expect(extractYamlBlock(markdown("version: 1"))?.trim()).toBe("version: 1")
	})

	it("returns undefined when there is no fence", () => {
		expect(extractYamlBlock("# Just prose")).toBeUndefined()
	})

	it("returns the prose with the fence removed", () => {
		const guidance = extractGuidance(markdown("version: 1", "Prefer the coding model."))
		expect(guidance).toContain("Prefer the coding model.")
		expect(guidance).not.toContain("version: 1")
	})
})

describe("normalizeRules", () => {
	it("falls back to defaults for a non-object document", () => {
		expect(normalizeRules(undefined).pool).toEqual(defaultRules().pool)
		expect(normalizeRules("nonsense").routes.length).toBeGreaterThan(0)
	})

	it("keeps a valid free pool", () => {
		const rules = normalizeRules({ pool: ["snps-provider/GLM-5.2", "snps-provider/kimi-k2.6"] })
		expect(rules.pool).toEqual(["snps-provider/GLM-5.2", "snps-provider/kimi-k2.6"])
	})

	it("drops paid model ids from the pool", () => {
		const rules = normalizeRules({
			pool: ["snps-aws-bedrock/global.anthropic.claude-sonnet-5", "azure-openai/gpt-5.2", "snps-provider/GLM-5.2"],
		})
		expect(rules.pool).toEqual(["snps-provider/GLM-5.2"])
	})

	it("falls back to the default pool when every id was rejected", () => {
		const rules = normalizeRules({ pool: ["azure-openai/gpt-5.2"] })
		expect(rules.pool).toEqual(defaultRules().pool)
	})

	it("de-duplicates pool entries", () => {
		const rules = normalizeRules({ pool: ["snps-provider/GLM-5.2", "snps-provider/GLM-5.2"] })
		expect(rules.pool).toEqual(["snps-provider/GLM-5.2"])
	})

	it("drops routes whose candidates are all paid", () => {
		const rules = normalizeRules({
			routes: [
				{ name: "paid", use: ["azure-openai/gpt-5.2"] },
				{ name: "free", use: ["snps-provider/GLM-5.2"] },
			],
		})
		expect(rules.routes).toEqual([{ name: "free", when: undefined, use: ["snps-provider/GLM-5.2"] }])
	})

	it("keeps an invalid promptRegex out of the parsed condition", () => {
		const rules = normalizeRules({
			routes: [{ name: "r", when: { promptRegex: "([unclosed" }, use: ["snps-provider/GLM-5.2"] }],
		})
		expect(rules.routes[0].when?.promptRegex).toBeUndefined()
	})

	it("parses a boolean subAgent condition and ignores anything else", () => {
		const use = ["snps-provider/GLM-5.2"]
		expect(normalizeRules({ routes: [{ name: "r", when: { subAgent: true }, use }] }).routes[0].when?.subAgent).toBe(true)
		expect(normalizeRules({ routes: [{ name: "r", when: { subAgent: false }, use }] }).routes[0].when?.subAgent).toBe(false)
		expect(
			normalizeRules({ routes: [{ name: "r", when: { subAgent: "yes" }, use }] }).routes[0].when?.subAgent,
		).toBeUndefined()
	})

	it("rejects a paid utility model and keeps the default", () => {
		const rules = normalizeRules({ utility: { summarizer: "azure-openai/gpt-5.2" } })
		expect(rules.utility.summarizer).toBe(defaultRules().utility.summarizer)
	})

	it("drops paid ids on every free profile, not only the default one", () => {
		for (const profile of ["fast", "smart"]) {
			const rules = normalizeRules(
				{
					pool: ["azure-openai/gpt-5.2", "snps-provider/GLM-5.2"],
					routes: [{ name: "r", use: ["azure-openai/gpt-5.2", "snps-provider/kimi-k2.6"] }],
					utility: { classifier: "snps-aws-bedrock/global-anthropic-claude-haiku-4-5-20251001-v1-0" },
				},
				undefined,
				profile,
			)
			expect(rules.pool, profile).toEqual(["snps-provider/GLM-5.2"])
			expect(rules.routes[0].use, profile).toEqual(["snps-provider/kimi-k2.6"])
			expect(rules.utility.classifier, profile).toBe(defaultRules(profile).utility.classifier)
		}
	})

	it("keeps a free utility model", () => {
		const rules = normalizeRules({ utility: { summarizer: "snps-provider/kimi-k2.6" } })
		expect(rules.utility.summarizer).toBe("snps-provider/kimi-k2.6")
	})

	it("treats the classifier as opt-in", () => {
		expect(normalizeRules({}).classifier.enabled).toBe(false)
		expect(normalizeRules({ classifier: { enabled: true } }).classifier.enabled).toBe(true)
		expect(normalizeRules({ classifier: { enabled: "yes" } }).classifier.enabled).toBe(false)
	})

	it("ignores non-positive health numbers", () => {
		const rules = normalizeRules({ health: { cooldownMs: -5, maxFailoversPerTurn: 0 } })
		expect(rules.health.cooldownMs).toBe(defaultRules().health.cooldownMs)
		expect(rules.health.maxFailoversPerTurn).toBe(defaultRules().health.maxFailoversPerTurn)
	})

	it("honours sticky:false but defaults to true", () => {
		expect(normalizeRules({}).sticky).toBe(true)
		expect(normalizeRules({ sticky: false }).sticky).toBe(false)
	})
})

describe("default routes", () => {
	const GLM = "snps-provider/GLM-5.2"
	const CODER = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
	const route = (name: string) => defaultRules().routes.find((r) => r.name === name)

	it("keeps the slow GLM-5.2 out of the everyday routes", () => {
		expect(route("coding")?.use).not.toContain(GLM)
		expect(route("default")?.use).not.toContain(GLM)
		expect(route("huge-context")?.use).toContain(GLM)
	})

	it("leads the coding route with the coder model and the long-task routes with kimi", () => {
		const KIMI = "snps-provider/kimi-k2.6"
		expect(route("coding")?.use[0]).toBe(CODER)
		expect(route("default")?.use[0]).toBe(KIMI)
		expect(route("subagent")?.use[0]).toBe(KIMI)
		expect(defaultPool()[0]).toBe(KIMI)
	})

	it("sends merge-conflict prompts to the coding route", () => {
		const pattern = new RegExp(route("coding")?.when?.promptRegex ?? "$^", "i")
		expect(pattern.test("resolve the merge conflicts")).toBe(true)
		expect(pattern.test("there is a type error in the build")).toBe(true)
	})

	it("gives sub-agent calls a dedicated route ahead of the general ones", () => {
		const names = defaultRules().routes.map((r) => r.name)
		expect(names.indexOf("subagent")).toBeLessThan(names.indexOf("coding"))
		expect(route("subagent")?.when).toEqual({ subAgent: true, maxEstimatedTokens: 100_000 })
	})

	it.each(["default", "fast", "smart", "balance"])("renders a %s starter file whose YAML really parses", (profile) => {
		const markdown = renderDefaultRulesMarkdown(profile)
		// Parse directly: parseRulesMarkdown would hide a YAML error behind the defaults.
		const document = yaml.load(extractYamlBlock(markdown) ?? "", { schema: yaml.JSON_SCHEMA })
		const parsed = normalizeRules(document, undefined, profile)
		expect(parsed).toEqual(defaultRules(profile))
	})

	it("keeps regex backslashes intact through the rendered file", () => {
		const document = yaml.load(extractYamlBlock(renderDefaultRulesMarkdown()) ?? "", {
			schema: yaml.JSON_SCHEMA,
		}) as { routes: Array<{ name: string; when?: { promptRegex?: string } }> }
		const coding = document.routes.find((r) => r.name === "coding")
		expect(coding?.when?.promptRegex).toBe(route("coding")?.when?.promptRegex)
	})
})

describe("profiles", () => {
	it("turns reasoning off on every route of the fast profile", () => {
		const routes = defaultRules("fast").routes
		expect(routes.every((r) => r.effort === "quick" && r.reasoningEffort === undefined)).toBe(true)
	})

	it("enables the classifier only for the smart profile", () => {
		expect(defaultRules().classifier.enabled).toBe(false)
		expect(defaultRules("fast").classifier.enabled).toBe(false)
		expect(defaultRules("smart").classifier.enabled).toBe(true)
	})

	it("keeps the smart classifier on when its file omits the flag", () => {
		expect(normalizeRules({ classifier: { timeoutMs: 5_000 } }, undefined, "smart").classifier.enabled).toBe(true)
		expect(normalizeRules({ classifier: { enabled: false } }, undefined, "smart").classifier.enabled).toBe(false)
	})

	it("thinks on the planning route and stays quick on the coding route by default", () => {
		const routes = defaultRules().routes
		expect(routes.find((r) => r.name === "plan-and-reasoning")).toMatchObject({
			effort: "think",
			reasoningEffort: "high",
			tier: "reason",
		})
		expect(routes.find((r) => r.name === "coding")).toMatchObject({ effort: "quick", tier: "code" })
	})

	it("parses tier, effort and reasoningEffort and drops unknown values", () => {
		const use = ["snps-provider/GLM-5.2"]
		const [good, bad] = normalizeRules({
			routes: [
				{ name: "good", tier: "Reason", effort: "think", reasoningEffort: "low", use },
				{ name: "bad", tier: "galaxy", effort: "sometimes", reasoningEffort: "extreme", use },
			],
		}).routes
		expect(good).toMatchObject({ tier: "reason", effort: "think", reasoningEffort: "low" })
		expect(bad.tier).toBeUndefined()
		expect(bad.effort).toBeUndefined()
		expect(bad.reasoningEffort).toBeUndefined()
	})
})

describe("balance profile", () => {
	const SONNET_5 = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"
	const HAIKU = "snps-aws-bedrock/global-anthropic-claude-haiku-4-5-20251001-v1-0"
	const KIMI = "snps-provider/kimi-k2.6"
	const route = (name: string) => defaultRules("balance").routes.find((r) => r.name === name)

	it("keeps paid ids in the pool, the routes and the utility models", () => {
		const rules = normalizeRules(
			{
				pool: [SONNET_5, "azure-openai/gpt-5.2", "snps-provider/GLM-5.2"],
				routes: [{ name: "paid", use: ["azure-openai/gpt-5.2", KIMI] }],
				utility: { classifier: HAIKU },
			},
			undefined,
			"balance",
		)
		expect(rules.pool).toEqual([SONNET_5, "azure-openai/gpt-5.2", "snps-provider/GLM-5.2"])
		expect(rules.routes).toEqual([{ name: "paid", when: undefined, use: ["azure-openai/gpt-5.2", KIMI] }])
		expect(rules.utility.classifier).toBe(HAIKU)
	})

	it("still refuses a virtual router id as a candidate", () => {
		const rules = normalizeRules(
			{ pool: ["pliny/free-auto", "pliny/balance-auto", SONNET_5], routes: [{ name: "r", use: ["pliny/free-auto"] }] },
			undefined,
			"balance",
		)
		expect(rules.pool).toEqual([SONNET_5])
		expect(rules.routes).toEqual(defaultRules("balance").routes)
	})

	it("leads difficult work with a paid model and simple work with a free one", () => {
		expect(route("coding")?.use[0]).toBe(SONNET_5)
		expect(route("default")?.use[0]).toBe(SONNET_5)
		expect(route("plan-and-reasoning")?.use[0]).toBe("aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking")
		expect(route("quick")?.use[0]).toBe(KIMI)
		expect(route("quick")?.use).toContain(HAIKU)
	})

	it("keeps sub-agents on free models with the cheap paid model as backup", () => {
		const subagent = route("subagent")
		expect(subagent?.when).toEqual({ subAgent: true })
		expect(subagent?.use[0]).toBe(KIMI)
		expect(subagent?.use[subagent.use.length - 1]).toBe(HAIKU)
		expect(subagent?.use.filter((id) => !id.startsWith("snps-provider"))).toEqual([HAIKU])
		const names = defaultRules("balance").routes.map((r) => r.name)
		expect(names.indexOf("subagent")).toBeLessThan(names.indexOf("coding"))
	})

	it("sends huge requests to the free 512k models", () => {
		expect(route("huge-context")?.use.every((id) => id.startsWith("snps-provider"))).toBe(true)
	})

	it("turns the classifier on and lists every routed id in the pool", () => {
		const rules = defaultRules("balance")
		expect(rules.classifier.enabled).toBe(true)
		const pool = new Set(rules.pool)
		for (const r of rules.routes) {
			for (const id of r.use) {
				expect(pool.has(id), `${r.name}: ${id}`).toBe(true)
			}
		}
	})

	it("keeps the utility jobs on free models by default", () => {
		const { utility } = defaultRules("balance")
		expect(Object.values(utility).every((id) => id.startsWith("snps-provider"))).toBe(true)
	})

	it("renders a starter file that explains the paid routing instead of the free-only guard", () => {
		const text = renderDefaultRulesMarkdown("balance")
		expect(text).toContain("# PlinyCode BalanceAuto routing rules")
		expect(text).toContain("billed at the model it actually lands on")
		expect(text).not.toContain("can never start spending money")
		expect(text).toContain(SONNET_5)
		// The FreeAuto file keeps its guard.
		expect(renderDefaultRulesMarkdown()).toContain("can never start spending money")
	})
})

describe("parseRulesMarkdown", () => {
	it("parses a well-formed file", () => {
		const rules = parseRulesMarkdown(
			markdown(["version: 1", "pool:", "  - snps-provider/GLM-5.2", "sticky: false"].join("\n")),
		)
		expect(rules.pool).toEqual(["snps-provider/GLM-5.2"])
		expect(rules.sticky).toBe(false)
		expect(rules.guidance).toContain("Guidance for the classifier.")
	})

	it("falls back to defaults for malformed YAML instead of throwing", () => {
		const rules = parseRulesMarkdown(markdown("pool: [unclosed\n  - broken: : :"))
		expect(() => parseRulesMarkdown(markdown("pool: [unclosed"))).not.toThrow()
		expect(rules.pool).toEqual(defaultRules().pool)
	})

	it("falls back to defaults when there is no yaml block", () => {
		const rules = parseRulesMarkdown("# Only prose here")
		expect(rules.pool).toEqual(defaultRules().pool)
	})
})

describe("mergeRules", () => {
	it("returns the global rules when there is no workspace file", () => {
		const global = defaultRules()
		expect(mergeRules(global, undefined)).toBe(global)
	})

	it("puts workspace routes first", () => {
		const global = { ...defaultRules(), routes: [{ name: "global", use: ["snps-provider/GLM-5.2"] }] }
		const workspace = { ...defaultRules(), routes: [{ name: "workspace", use: ["snps-provider/kimi-k2.6"] }] }
		const merged = mergeRules(global, workspace)
		expect(merged.routes[0].name).toBe("workspace")
		expect(merged.routes[1].name).toBe("global")
	})

	it("lets a workspace scalar win", () => {
		const global = { ...defaultRules(), sticky: true }
		const workspace = { ...defaultRules(), sticky: false }
		expect(mergeRules(global, workspace).sticky).toBe(false)
	})
})
