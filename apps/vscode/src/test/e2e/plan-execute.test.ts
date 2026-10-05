import { readFileSync, rmSync } from "node:fs"
import * as path from "node:path"
import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

// Plan with one model, execute with another (docs/plan-mode.md). The mock
// answers `plan_request` with an editor call that writes plans/e2e-plan/PLAN.md,
// so the plan row offers the Execute plan split button.
e2e(
	"Plan - Execute plan runs on the model picked from the button's menu",
	async ({ helper, sidebar, workspaceDir, userDataDir }) => {
		// The plan lands in the checked-in fixture workspace; remove it afterwards.
		const plansDir = path.join(workspaceDir, "plans")
		const modelPicker = sidebar.getByTitle(/^Select model/)

		try {
			await helper.ensureReady(sidebar)

			const planSwitch = sidebar.getByRole("switch", { name: "Plan" })
			const actSwitch = sidebar.getByRole("switch", { name: "Act" })
			await planSwitch.click()
			await expect(planSwitch).toHaveAttribute("aria-checked", "true")

			// One model for both modes is the default, so this is the planner's and
			// act mode's model. A router other than the default one, so that FreeAuto
			// is a different model to hand the plan to.
			await modelPicker.click()
			await sidebar.getByRole("option", { name: /auto-free-fast/ }).click()
			await expect(modelPicker).toContainText("auto-free-fast")

			const inputbox = sidebar.getByTestId("chat-input")
			await inputbox.fill("plan_request")
			await sidebar.getByTestId("send-button").click({ delay: 50 })

			// The button names the model a click would run the plan on.
			await expect(sidebar.getByRole("button", { name: "Execute plan · auto-free-fast (router)" })).toBeVisible({
				timeout: 30_000,
			})
			expect(readFileSync(path.join(plansDir, "e2e-plan", "PLAN.md"), "utf-8")).toContain("# E2E plan")

			await sidebar.getByRole("button", { name: "Execute with another model" }).click()
			const rows = sidebar.getByRole("menuitemradio")
			await expect(rows).toHaveCount(2)
			await expect(rows.nth(0)).toContainText("act mode model (default)")
			await expect(rows.nth(0)).toHaveAttribute("aria-checked", "true")
			await rows.filter({ hasText: "FreeAuto" }).click()

			// The plan is executed in act mode, in the same conversation.
			await expect(actSwitch).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })
			await expect(sidebar.getByText("execute the plan in plans/e2e-plan/PLAN.md")).toBeVisible({ timeout: 30_000 })
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
		} finally {
			rmSync(plansDir, { recursive: true, force: true })
		}
	},
)
