import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { expect } from "@playwright/test"
import { E2ETestHelper, e2e } from "./utils/helpers"

/**
 * Seeds an SDK session history record the way a completed task persists it
 * (~/.cline/data/sessions/<id>/<id>.json, snake_case on disk). `provider` is
 * the field the cost-display suppression keys on.
 */
function seedSessionRecord(
	clineDir: string,
	options: { id: string; provider: string; title: string; totalCost: number; ts: number; isFavorited?: boolean },
): void {
	const { id, provider, title, totalCost, ts, isFavorited = false } = options
	const startedAt = new Date(ts).toISOString()
	const sessionDir = path.join(clineDir, "data", "sessions", id)
	mkdirSync(sessionDir, { recursive: true })
	writeFileSync(
		path.join(sessionDir, `${id}.json`),
		JSON.stringify({
			version: 1,
			session_id: id,
			source: "vscode",
			pid: 1,
			started_at: startedAt,
			ended_at: startedAt,
			exit_code: 0,
			status: "completed",
			interactive: true,
			provider,
			model: "test-model",
			cwd: "/tmp/e2e-history",
			workspace_root: "/tmp/e2e-history",
			enable_tools: true,
			enable_spawn: false,
			enable_teams: false,
			prompt: title,
			metadata: {
				title,
				isFavorited,
				size: 1024,
				totalCost,
				tokensIn: 100,
				tokensOut: 50,
				cacheWrites: 0,
				cacheReads: 0,
				modelId: "test-model",
				legacyTask: false,
			},
			updated_at: startedAt,
		}),
	)
	writeFileSync(path.join(sessionDir, `${id}.messages.json`), "[]")
}

// DISABLED (Pliny-only refactor): this suite asserts that the HistoryView hides
// cost estimates for `openai-codex` ("subscription" billing) while showing them
// for `anthropic` ("usage" billing). That cost-display suppression is keyed on
// per-provider `usageCostDisplay` metadata for non-Pliny providers, which the
// Pliny-only product is phasing out — the only live provider is `pliny`, so the
// subscription/usage distinction no longer applies to anything users see. The
// seed also writes SDK `sessions/<id>/<id>.json` records; re-enabling requires
// confirming the SDK session-history reader path and that the Pliny provider's
// cost rendering matches whatever the HistoryView expects. Re-enable only if
// Pliny ever surfaces per-call cost estimates in the history list again.
e2e.skip("History - hides cost estimates for subscription-billed tasks", async ({ app, page, helper, server: _server }) => {
	// Seed history BEFORE the webview loads so its first state fetch sees the
	// records (the extension caches history metadata for ~10s).
	const clineDir = await app.evaluate(() => process.env.CLINE_DIR)
	expect(clineDir).toBeTruthy()

	const now = Date.now()
	// openai-codex is marked usageCostDisplay = "subscription" in the SDK; its
	// stored totalCost is an API-rate estimate, not a real charge.
	seedSessionRecord(clineDir as string, {
		id: `${now - 1000}_subtask`,
		provider: "openai-codex",
		title: "Subscription billed e2e task",
		totalCost: 0.4242,
		ts: now - 1000,
	})
	// anthropic is usage-billed; its cost must keep rendering.
	seedSessionRecord(clineDir as string, {
		id: `${now - 2000}_apitask`,
		provider: "anthropic",
		title: "Usage billed e2e task",
		totalCost: 0.1337,
		ts: now - 2000,
	})

	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await helper.ensureReady(sidebar)

	// Recent-task chips in the empty chat view (HistoryPreview)
	await expect(sidebar.getByText("Recent")).toBeVisible()
	await expect(sidebar.getByText("Subscription billed e2e task")).toBeVisible()
	await expect(sidebar.getByText("Usage billed e2e task")).toBeVisible()
	await expect(sidebar.getByText("$0.13")).toBeVisible()
	await expect(sidebar.getByText("$0.42")).not.toBeVisible()

	// Full history page (HistoryView) — scope to the virtualized list, since
	// the HistoryPreview beneath still holds matching task titles.
	await sidebar.getByRole("button", { name: "View all history" }).click()
	const historyList = sidebar.getByTestId("virtuoso-item-list")
	await expect(historyList.getByText("Subscription billed e2e task")).toBeVisible()
	await expect(historyList.getByText("Usage billed e2e task")).toBeVisible()
	await expect(historyList.getByText("$0.1337")).toBeVisible()
	await expect(historyList.getByText("$0.4242")).not.toBeVisible()
})

e2e("History - filters favorites, searches, and pins conversations", async ({ app, page, helper, server: _server }) => {
	// Seed history BEFORE the webview loads so its first state fetch sees the records.
	const clineDir = await app.evaluate(() => process.env.CLINE_DIR)
	expect(clineDir).toBeTruthy()

	const now = Date.now()
	const day = 24 * 60 * 60 * 1000
	// More recent conversations than one page holds (50), so the favorite is not on the first page.
	for (let index = 0; index < 55; index++) {
		seedSessionRecord(clineDir as string, {
			id: `${now - 60_000 - index * 1000}_filler${index}`,
			provider: "pliny",
			title: `Filler e2e task ${index}`,
			totalCost: 0,
			ts: now - 60_000 - index * 1000,
		})
	}
	seedSessionRecord(clineDir as string, {
		id: `${now - 60 * day}_favorite`,
		provider: "pliny",
		title: "Old favorite e2e task",
		totalCost: 0,
		ts: now - 60 * day,
		isFavorited: true,
	})
	seedSessionRecord(clineDir as string, {
		id: `${now - 30 * day}_searchable`,
		provider: "pliny",
		title: "Searchable old e2e task",
		totalCost: 0,
		ts: now - 30 * day,
	})

	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await helper.ensureReady(sidebar)

	// A conversation of this window, to pin: the seeded records are manifest
	// files only, and a pin written to one of them did not stick.
	const inputbox = sidebar.getByTestId("chat-input")
	await inputbox.fill("Pin me e2e task")
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText("mock Cline API response")).toBeVisible({ timeout: 30_000 })
	await sidebar.getByRole("button", { name: "New Task", exact: true }).first().click()

	await sidebar.getByRole("button", { name: "View all history" }).click()
	// The seeded conversations belong to another folder than the test window's.
	await sidebar.getByRole("combobox", { name: "Filter history by workspace" }).click()
	await sidebar.getByRole("option", { name: "All workspaces" }).click()
	const historyList = sidebar.getByTestId("virtuoso-item-list")
	await expect(historyList.getByText("Filler e2e task 0", { exact: true })).toBeVisible()

	// The favorites filter finds a favorite older than the first page of results.
	const favorites = sidebar.getByRole("button", { name: "Show only favorites" })
	await favorites.click()
	await expect(historyList.getByText("Old favorite e2e task")).toBeVisible()
	await expect(historyList.getByText("Filler e2e task 0", { exact: true })).not.toBeVisible()
	await favorites.click()
	await expect(historyList.getByText("Filler e2e task 0", { exact: true })).toBeVisible()

	// Search finds an old conversation, and the date filter narrows the search.
	const search = sidebar.locator('input[placeholder="Search history..."]')
	await search.fill("old searchable")
	await expect(historyList.getByText("Searchable old e2e task")).toBeVisible()
	await expect(historyList.getByText("Filler e2e task 0", { exact: true })).not.toBeVisible()
	await sidebar.getByRole("combobox", { name: "Filter history by date" }).click()
	await sidebar.getByRole("option", { name: "Last 7 days" }).click()
	await expect(sidebar.getByText("No conversations match these filters.")).toBeVisible()
	await sidebar.getByRole("button", { name: "Clear filters" }).click()
	await expect(historyList.getByText("Filler e2e task 0", { exact: true })).toBeVisible()

	// Pinning moves the conversation to a Pinned section at the top of the list.
	await search.fill("pin me")
	await historyList.getByRole("button", { name: "Pin conversation" }).click()
	await expect(historyList.getByRole("button", { name: "Unpin conversation" })).toBeVisible()
	await sidebar.getByRole("button", { name: "Clear filters" }).click()
	await expect(sidebar.getByText("Pinned", { exact: true })).toBeVisible()
	await expect(historyList.getByText("Pin me e2e task")).toBeVisible()
	await expect(historyList.getByText("Filler e2e task 0", { exact: true })).toBeVisible()
})
