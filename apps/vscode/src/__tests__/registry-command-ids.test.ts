import { describe, it } from "bun:test"
import { expect } from "chai"
import packageJson from "../../package.json"
import { ExtensionRegistryInfo } from "../registry"

/**
 * `package.json` declares the extension's command IDs verbatim (`cline.*`), and
 * `registry.ts` rebuilds the same IDs to register handlers and to wire the
 * webview buttons. If the two drift, VS Code still renders the contributed
 * title-bar buttons but their commands never register, so clicking "Settings"
 * or "History" silently does nothing.
 *
 * That desync happened once already: the `claude-dev` -> `plinycode-dev`
 * package rename flipped the registry prefix away from `cline`, which only the
 * Windows-only e2e suite caught. These tests pin the contract cheaply.
 */
describe("registry command IDs", () => {
	// `cline.dev.*` commands are dev-only helpers registered with hardcoded
	// literals in src/dev/commands, so they deliberately never reach the registry.
	const contributedCommands = new Set(
		packageJson.contributes.commands.map((command) => command.command).filter((id) => !id.startsWith("cline.dev.")),
	)

	it("registers a handler for every command package.json contributes", () => {
		const registered = new Set(Object.values(ExtensionRegistryInfo.commands))

		// Every contributed command is reachable from the UI (palette, title-bar
		// menus, editor context menu), so each one needs a matching registered ID.
		// This is the direction that actually breaks users: a contributed button
		// whose command never registers renders fine but does nothing on click.
		const unregistered = [...contributedCommands].filter((id) => !registered.has(id))

		expect(
			unregistered,
			`commands contributed by package.json with no ID in registry.ts: ${unregistered.join(", ")}`,
		).to.deep.equal([])
	})

	it("keeps the legacy `cline.` prefix regardless of the package name", () => {
		// The `cline.*` command IDs are intentionally frozen: renaming them would
		// break existing installs and the contributed menus.
		const wrongPrefix = Object.values(ExtensionRegistryInfo.commands).filter((id) => !id.startsWith("cline."))

		expect(wrongPrefix, `command IDs must start with "cline.": ${wrongPrefix.join(", ")}`).to.deep.equal([])
	})

	it("derives view IDs from the package name", () => {
		// Unlike commands, view IDs DID follow the rename and must match
		// package.json's `contributes.views` entry.
		const contributedViewIds = Object.values(packageJson.contributes.views)
			.flat()
			.map((view) => view.id)

		expect(contributedViewIds).to.include(ExtensionRegistryInfo.views.Sidebar)
	})
})
