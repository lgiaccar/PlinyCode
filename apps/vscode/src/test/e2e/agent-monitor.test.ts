import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

e2e("Agent monitor - registered backend supplies the saved configuration", async ({ helper, sidebar, page }) => {
	await helper.ensureReady(sidebar)
	await page.keyboard.press("ControlOrMeta+Shift+p")
	await page.locator(".quick-input-widget input").fill(">Pipelines")
	await page.keyboard.press("Enter")
	await sidebar.getByRole("button", { name: "Agents", exact: true }).click()
	// This form only exists after the real extension host answers subscribeToAgents.
	await expect(sidebar.getByLabel("Agent-pool URL")).toBeVisible({ timeout: 15_000 })
	await expect(sidebar.getByLabel("Agent-pool URL")).toHaveValue("")
	await expect(sidebar.getByRole("button", { name: "Start monitoring", exact: true })).toBeDisabled()
	await expect(sidebar.getByText("Unknown service: cline.AgentMonitorService", { exact: true })).not.toBeVisible()
	await expect(sidebar.getByRole("status")).toContainText("Monitoring stopped.")
})
