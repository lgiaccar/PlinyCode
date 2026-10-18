import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { e2e } from "./utils/helpers"

// The mock answers `plan_request` with an editor call that writes
// <plans folder>/e2e-plan/PLAN.md, in the folder the plan-mode system prompt
// names, so the plan row offers the Execute plan split button.

/** Sends `plan_request` in plan mode and waits for the plan row; returns the plan file's path. */
async function presentPlan(sidebar: Frame, workspaceDir: string): Promise<string> {
	const planSwitch = sidebar.getByRole("switch", { name: "Plan" })
	await planSwitch.click()
	await expect(planSwitch).toHaveAttribute("aria-checked", "true")

	const inputbox = sidebar.getByTestId("chat-input")
	await inputbox.fill("plan_request")
	await sidebar.getByTestId("send-button").click({ delay: 50 })

	// The link names the plan by its folder and file; its title has the full path.
	const link = sidebar.getByTitle(/^Open .*e2e-plan\/PLAN\.md to review or edit the plan$/)
	await expect(link).toBeVisible({ timeout: 30_000 })
	await expect(link).toHaveText("e2e-plan/PLAN.md")
	const title = (await link.getAttribute("title")) ?? ""
	const planFile = title.replace(/^Open /, "").replace(/ to review or edit the plan$/, "")

	// Plans live in PlinyCode's data folder, not in the workspace.
	expect(path.isAbsolute(planFile)).toBe(true)
	expect(planFile.replace(/\\/g, "/")).toMatch(/\/data\/plans\/[^/]+-[0-9a-f]{8}\/e2e-plan\/PLAN\.md$/)
	expect(readFileSync(planFile, "utf-8")).toContain("# E2E plan")
	expect(existsSync(path.join(workspaceDir, "plans"))).toBe(false)
	return planFile
}

e2e(
	"Plan - Execute plan runs on the model picked from the button's menu",
	async ({ helper, sidebar, workspaceDir, userDataDir }) => {
		const modelPicker = sidebar.getByTitle(/^Select model/)
		const planSwitch = sidebar.getByRole("switch", { name: "Plan" })
		const actSwitch = sidebar.getByRole("switch", { name: "Agent" })

		await helper.ensureReady(sidebar)

		// One model for both modes is the default, so this is the planner's and
		// act mode's model. A router other than the default one, so that FreeAuto
		// is a different model to hand the plan to.
		await modelPicker.click()
		await sidebar.getByRole("option", { name: /auto-free-fast/ }).click()
		await expect(modelPicker).toContainText("auto-free-fast")

		await presentPlan(sidebar, workspaceDir)

		// The button names the model a click would run the plan on.
		await expect(sidebar.getByRole("button", { name: "Execute plan · auto-free-fast (router)" })).toBeVisible()

		await sidebar.getByRole("button", { name: "Execute with another model" }).click()
		const rows = sidebar.getByRole("menuitemradio")
		await expect(rows).toHaveCount(2)
		await expect(rows.nth(0)).toContainText("Agent mode model (default)")
		await expect(rows.nth(0)).toHaveAttribute("aria-checked", "true")
		await rows.filter({ hasText: "FreeAuto" }).click()

		// The plan is executed in act mode, in the same conversation.
		await expect(actSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })
		// .first(): the sticky "Scroll to your message" header repeats the text once the message scrolls away.
		await expect(sidebar.getByText(/^execute the plan in .*e2e-plan\/PLAN\.md$/).first()).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("The mock plan has been executed.")).toBeVisible({ timeout: 30_000 })

		// Act mode now runs on FreeAuto, and the choice is remembered as a setting.
		await expect(modelPicker).toContainText("auto-free (router)")
		await expect
			.poll(() => readFileSync(path.join(userDataDir, "User", "settings.json"), "utf-8"), { timeout: 10_000 })
			.toMatch(/"plinycode\.plan\.executeWith":\s*"freeAuto"/)

		// The planner keeps its model.
		await planSwitch.click()
		await expect(planSwitch).toHaveAttribute("aria-checked", "true")
		await expect(modelPicker).toContainText("auto-free-fast")
	},
)

e2e("Plan - switching to Agent mode does not run the plan", async ({ helper, sidebar, workspaceDir }) => {
	const actSwitch = sidebar.getByRole("switch", { name: "Agent" })

	await helper.ensureReady(sidebar)
	const planFile = await presentPlan(sidebar, workspaceDir)

	// A draft in the prompt box is not an instruction to execute.
	const inputbox = sidebar.getByTestId("chat-input")
	await inputbox.fill("a draft")
	await actSwitch.click()
	await expect(actSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })
	await expect(inputbox).toHaveValue("a draft")
	// Give a continuation that should not happen the time to show up.
	await sidebar.waitForTimeout(3_000)
	await expect(sidebar.getByText("The mock plan has been executed.")).toHaveCount(0)

	// Asked in Agent mode, it runs.
	await inputbox.fill(`execute the plan in ${planFile}`)
	await sidebar.getByTestId("send-button").click({ delay: 50 })
	await expect(sidebar.getByText("The mock plan has been executed.")).toBeVisible({ timeout: 30_000 })
})
