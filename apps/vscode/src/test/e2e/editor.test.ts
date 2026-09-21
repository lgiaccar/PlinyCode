import { expect } from "@playwright/test"
import { addSelectedCodeToClineWebview, openTab, toggleNotifications } from "./utils/common"
import { E2E_WORKSPACE_TYPES, e2e } from "./utils/helpers"

// SKIPPED (Pliny-only refactor): the Cline-account onboarding/sign-in flow this suite
// relied on was removed (welcomeViewCompleted is now hardcoded true) and the e2e mock
// server speaks the Cline/OpenRouter API, not the Pliny gateway (Anthropic-style,
// CI-unreachable, no PLINY_API_KEY). Re-enable after the Pliny e2e harness is rebuilt
// (replace helper.signin; retarget/replace the mock server for the Pliny provider).
// See src/test/e2e/README.md.
e2e.describe.skip("Code Actions and Editor Panel", () => {
	E2E_WORKSPACE_TYPES.forEach(({ title, workspaceType }) => {
		e2e.extend({
			workspaceType,
		})(title, async ({ helper, page, sidebar }) => {
			await helper.signin(sidebar)
			// Sidebar - input should start empty
			const sidebarInput = sidebar.getByTestId("chat-input")
			await sidebarInput.click()
			await toggleNotifications(page)
			await expect(sidebarInput).toBeEmpty()

			// Open file tree and select code from file
			await openTab(page, "Explorer ")
			await page.getByRole("treeitem", { name: "index.html" }).locator("a").click()
			await expect(sidebarInput).not.toBeFocused()

			// Sidebar should be opened and visible after adding code to Cline
			await addSelectedCodeToClineWebview(page)
			await expect(sidebarInput).not.toBeEmpty()
			await expect(sidebarInput).toBeFocused()
		})
	})
})
