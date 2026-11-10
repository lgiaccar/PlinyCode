# Searchable settings

Use **Search settings** at the top of Settings to find PlinyCode's declared editor settings by name or
description. **Browse settings** lists all of them; **Modified only** keeps settings with an explicit User,
Workspace or Folder override (even one equal to the default). Search also offers links to the dedicated
API configuration, Router, Features, Terminal, General and About sections. Model tuning, API-key storage and
other app-managed controls remain in those sections; they are not editor configuration overrides.

Each editor setting shows its effective value, default and winning **Source**. The resource is the active
editor document, falling back to the first workspace folder. Choose **Edit scope** before saving or resetting.
Boolean, number, string and enum values can be edited here; complex values open in the editor's settings UI.
The host validates types, enum options and numeric limits against the extension's declared setting schema.

**Reset user**, **Reset workspace** or **Reset folder** removes only that scope's override, allowing a lower
scope to take effect. A higher-priority override can still win; the resulting effective value and Source make
that visible. Reset never replaces an override with a copied default. If the active resource changed, refresh
before editing, so a workspace/folder change cannot be applied to a different resource by accident.

The catalog reads non-language-specific editor configuration. Language-specific overrides, if manually
configured, are managed in the native editor settings. Use **Refresh** after external configuration changes.
