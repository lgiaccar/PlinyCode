import type { Page } from "@playwright/test"

export const openTab = async (_page: Page, tabName: string) => {
	await _page
		.getByRole("tab", { name: new RegExp(`${tabName}`) })
		.locator("a")
		.click()
}

export const addSelectedCodeToClineWebview = async (_page: Page) => {
	await _page.locator("div:nth-child(4) > span > span").first().click()
	await _page.getByRole("textbox", { name: "The editor is not accessible" }).press("ControlOrMeta+a")

	// Open Code Actions via keyboard for cross-platform reliability
	await _page.keyboard.press("ControlOrMeta+.")

	// Target the explicit action instead of pressing Enter on the first item.
	// The first item can vary by platform or diagnostics.
	const addToCline = _page.getByText(/Add to PlinyCode/i)
	await addToCline.waitFor({ state: "visible" })
	// For whatever reason, we need to move the mouse to make the context menu item clickable
	await _page.mouse.move(10, 10)
	await _page.mouse.move(20, 10)
	await addToCline.click()
}

export const toggleNotifications = async (_page: Page) => {
	await _page.waitForLoadState("domcontentloaded")
	await _page.keyboard.press("ControlOrMeta+Shift+p")
	// Older VS Code hosts expose this input as a combobox, newer hosts as a
	// textbox. Scope to the command palette instead of relying on its ARIA role.
	const editorSearchBar = _page.locator('.quick-input-widget input[type="text"]')
	await editorSearchBar.click({ delay: 100 }) // Ensure focus
	await editorSearchBar.fill("> Toggle Do Not Disturb Mode")
	await _page.keyboard.press("Enter")
	return _page
}
