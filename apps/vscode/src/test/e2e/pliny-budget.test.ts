import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

e2e("Pliny budget - visible on home and recovers from a service outage", async ({ helper, sidebar, server }) => {
	await helper.ensureReady(sidebar)
	const balance = sidebar.getByText("Pliny budget: $80.00 left of $200.00 this month", { exact: true })
	await expect(balance).toBeVisible({ timeout: 15_000 })
	if (!server) throw new Error("Mock server is unavailable")
	try {
		server.budgetStatus = 503
		await sidebar.getByRole("button", { name: "Refresh Pliny budget" }).click()
		await expect(sidebar.getByText(/Last known.*Pliny budget/)).toBeVisible()
		await expect(sidebar.getByText(/budget service is unavailable \(HTTP 503\)/)).toBeVisible()
		server.budgetStatus = 200
		await sidebar.getByRole("button", { name: "Refresh Pliny budget" }).click()
		await expect(balance).toBeVisible()
		await expect(sidebar.getByText(/Last known.*Pliny budget/)).not.toBeVisible()
	} finally {
		server.budgetStatus = 200
	}
})
