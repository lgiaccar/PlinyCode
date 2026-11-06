import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

e2e("Agent monitor - registered backend supplies the saved configuration", async ({ helper, sidebar, page }) => {
	await helper.ensureReady(sidebar)
	await page.getByRole("button", { name: "Pipelines", exact: true }).click()
	await sidebar.getByRole("button", { name: "Agents", exact: true }).click()
	// This form only exists after the real extension host answers subscribeToAgents.
	await expect(sidebar.getByLabel("Agent-pool URL")).toBeVisible({ timeout: 15_000 })
	await expect(sidebar.getByLabel("Agent-pool URL")).toHaveValue("")
	await expect(sidebar.getByRole("button", { name: "Start monitoring", exact: true })).toBeDisabled()
	await expect(sidebar.getByText("Unknown service: cline.AgentMonitorService", { exact: true })).not.toBeVisible()
	await expect(sidebar.getByRole("status")).toContainText("Monitoring stopped.")
	// Save two stopped pools through the real RPC/storage path, without contacting Azure DevOps.
	const first = "https://ado.example/collection/project/_settings/agentqueues?queueId=1&view=agents"
	const second = first.replace("queueId=1", "queueId=2")
	await sidebar.getByRole("textbox", { name: "Agent-pool URL" }).fill(first)
	await sidebar.getByRole("button", { name: "Save pool", exact: true }).click()
	await expect(sidebar.getByRole("button", { name: "Save pool", exact: true })).toBeEnabled()
	await sidebar.getByRole("button", { name: "Add pool", exact: true }).click()
	await sidebar.getByRole("textbox", { name: "Agent-pool URL" }).fill(second)
	await sidebar.getByRole("button", { name: "Save pool", exact: true }).click()
	await expect(sidebar.getByRole("button", { name: "Cancel adding pool" })).not.toBeVisible()
	const picker = sidebar.getByRole("combobox", { name: "Agent pool", exact: true })
	await expect(picker.locator("option")).toHaveCount(2)
	await picker.selectOption("default")
	await expect(sidebar.getByRole("textbox", { name: "Agent-pool URL" })).toHaveValue(first)
	await sidebar.getByRole("button", { name: "Runs", exact: true }).click()
	await sidebar.getByRole("button", { name: "Agents", exact: true }).click()
	await expect(picker.locator("option")).toHaveCount(2)
	await picker.selectOption({ index: 1 })
	await expect(sidebar.getByRole("textbox", { name: "Agent-pool URL" })).toHaveValue(second)
	await sidebar.getByRole("button", { name: "Remove pool", exact: true }).click()
	await expect(picker.locator("option")).toHaveCount(1)
	await expect(sidebar.getByRole("textbox", { name: "Agent-pool URL" })).toHaveValue(first)
})
