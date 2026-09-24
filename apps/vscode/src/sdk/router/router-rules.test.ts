import { describe, expect, it } from "vitest"
import {
	defaultPool,
	defaultRules,
	extractGuidance,
	extractYamlBlock,
	mergeRules,
	normalizeRules,
	parseRulesMarkdown,
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

	it("leads the coding and default routes with the coder model", () => {
		expect(route("coding")?.use[0]).toBe(CODER)
		expect(route("default")?.use[0]).toBe(CODER)
		expect(defaultPool()[0]).toBe(CODER)
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

	it("survives a render/parse round trip of the starter rules file", () => {
		const parsed = parseRulesMarkdown(renderDefaultRulesMarkdown())
		const defaults = defaultRules()
		expect(parsed.routes.map((r) => r.name)).toEqual(defaults.routes.map((r) => r.name))
		expect(parsed.routes.find((r) => r.name === "subagent")?.when).toEqual(route("subagent")?.when)
		expect(parsed.routes.find((r) => r.name === "coding")?.when).toEqual(route("coding")?.when)
		expect(parsed.pool).toEqual(defaults.pool)
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
