import { describe, expect, it } from "bun:test"
import { itemActions } from "../ci-board-actions"
import { noSkills } from "../ci-skills"
import { type CiBoardItem, type CiTriageResult, defaultActions } from "../types"
import { boardPr, SHA_A } from "./fake-board-provider"

const base: CiBoardItem = {
	key: "k",
	pr: boardPr(12, { sourceBranch: "feature", targetBranch: "stage" }),
	branch: "feature",
	headSha: SHA_A,
	mergeState: "clean",
	fork: false,
	pipelines: [{ name: "ci", color: "red", status: "completed", result: "failure", runId: 1 }],
}

const triage = (recommended: CiTriageResult["recommended"]): CiTriageResult => ({
	fingerprint: "f",
	itemKey: "k",
	status: "done",
	severity: "low",
	summary: "",
	pipelines: [],
	conflict: false,
	recommended,
	source: "model",
	analyzedTs: 0,
})

const primary = (item: CiBoardItem, t?: CiTriageResult) =>
	itemActions({ actions: defaultActions(), item, triage: t, skills: noSkills() }).find((a) => a.role === "primary")?.actionId

describe("itemActions", () => {
	it("picks the main button from the item's state", () => {
		expect(primary({ ...base, mergeState: "conflicts" })).toBe("fix-conflicts")
		expect(primary(base, triage(["recalibrate"]))).toBe("recalibrate")
		expect(primary(base, triage(["fix-ci"]))).toBe("fix-ci")
		expect(primary(base)).toBe("fix-ci")
		expect(primary({ ...base, pipelines: [{ name: "ci", color: "green" }] })).toBeUndefined()
	})

	it("lists every action, main button first, with tooltips that say where and on which model", () => {
		const skills = noSkills()
		skills["fix-conflicts"] = [{ name: "fix-conflicts", path: "/r/.github/skills/fix-conflicts/SKILL.md" }]
		const actions = itemActions({
			actions: [
				...defaultActions(),
				{
					id: "mine",
					label: "Deltas",
					prompt: { kind: "file", path: "AI/x.md" },
					model: "current",
					situation: "any",
					auto: false,
				},
			],
			item: { ...base, mergeState: "conflicts" },
			skills,
			blocked: "This pull request comes from a fork; its branch cannot be pushed to from here.",
		})
		expect(actions.map((a) => [a.actionId, a.role])).toEqual([
			["fix-conflicts", "primary"],
			["recalibrate", "menu"],
			["fix-ci", "menu"],
			["investigate", "menu"],
			["mine", "menu"],
		])
		expect(actions[0].tooltip).toContain("Merges stage into feature")
		expect(actions[0].tooltip).toContain("/fix-conflicts skill")
		expect(actions[0].tooltip).toContain("FreeAuto")
		expect(actions[3].tooltip).toContain("Ask mode")
		expect(actions[4].tooltip).toContain("Runs the prompt in AI/x.md")
		expect(actions[4].tooltip).toContain("the model selected in the chat")
		expect(actions.every((a) => a.disabledReason?.includes("fork"))).toBe(true)
	})

	it("marks the actions the triage recommends", () => {
		const actions = itemActions({ actions: defaultActions(), item: base, triage: triage(["fix-ci"]), skills: noSkills() })
		expect(actions.filter((a) => a.recommended).map((a) => a.actionId)).toEqual(["fix-ci"])
	})
})
