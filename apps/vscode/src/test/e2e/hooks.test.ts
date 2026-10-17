import { expect } from "@playwright/test"
import fs from "fs/promises"
import path from "path"
import { E2ETestHelper, e2e } from "./utils/helpers"

// This spec runs against its own fixture workspace: hooks execute on every
// prompt once discovered (hooksEnabled defaults to true), so keeping the hook
// out of the shared workspace fixture spares every other prompt-sending spec
// the per-prompt hook spawn.
const hooksE2e = e2e.extend({
	workspaceDir: async ({}, use) => {
		await use(path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-hooks"))
	},
})

// The fixture ships a UserPromptSubmit hook
// (.clinerules/hooks/UserPromptSubmit.js, run through node by the engine on
// every platform) that writes hook-ran.json into its working directory,
// recording process.cwd() and the workspaceRoots it received on stdin. The
// engine runs hook files in the session's workspace, so the marker must land
// in this window's workspace root and name it — regardless of what any other
// instance recorded in shared state.
hooksE2e("Hooks - workspace hook runs from this window's workspace root", async ({ helper, sidebar, workspaceDir }) => {
	const markerPath = path.join(workspaceDir, "hook-ran.json")
	await fs.rm(markerPath, { force: true })

	try {
		await helper.ensureReady(sidebar)

		const inputbox = sidebar.getByTestId("chat-input")
		await expect(inputbox).toBeVisible()
		await inputbox.fill("Trigger the prompt hook")
		await sidebar.getByTestId("send-button").click()

		// Generous timeout: the mock streams word-by-word and CI runners can be slow.
		await expect(sidebar.getByText("mock Cline API response")).toBeVisible({ timeout: 30_000 })

		// First half: the engine ran the hook file. UserPromptSubmit is not
		// awaited by the run, so the marker can land after the response: poll for it.
		let markerRaw: string | undefined
		await expect
			.poll(
				async () => {
					markerRaw = await fs.readFile(markerPath, "utf-8").catch(() => undefined)
					return markerRaw
				},
				{
					message:
						"the engine did not run the workspace hook: no hook-ran.json in the workspace root (hook not discovered, filtered out, or failed to start)",
					timeout: 15_000,
				},
			)
			.toBeDefined()

		// Second half: the engine reported the run and the extension turned the
		// report into a hook_status row naming the hook.
		await expect(
			sidebar.getByText("UserPromptSubmit").first(),
			"the hook ran but no UserPromptSubmit hook_status row reached the chat",
		).toBeVisible({ timeout: 15_000 })

		const marker = JSON.parse(markerRaw ?? "{}")

		// Normalize with realpath: macOS reports temp/workspace paths under
		// /private while the fixture path may not carry the prefix.
		const expectedRoot = await fs.realpath(workspaceDir)
		expect(await fs.realpath(marker.cwd)).toBe(expectedRoot)

		expect(Array.isArray(marker.workspaceRoots)).toBe(true)
		const reportedRoots: string[] = []
		for (const root of marker.workspaceRoots) {
			reportedRoots.push(await fs.realpath(root))
		}
		expect(reportedRoots).toContain(expectedRoot)
	} finally {
		await fs.rm(markerPath, { force: true })
	}
})
