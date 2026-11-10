# Interface density

Choose **Settings > General > Interface density** to switch between **Comfortable** (the default) and
**Compact**. The preference takes effect immediately and is stored as `plinycode.ui.density` in the editor's
settings. It changes vertical spacing in chat rows, the task header, CI Board rows, settings sections and
the delivery, attention and context panels. Text size and available actions stay the same.

The selector edits the currently effective User, Workspace or Folder override, using User when no override
exists. A folder override follows the active editor's resource, or the first workspace folder when no
editor is active. Use [settings search](settings-search.md) to choose a different scope or reset an override.

The new inspection panels share theme-aware borders, rounded corners, form controls and visible keyboard
focus. Compact controls remain at least 26 pixels high. Help and error paragraphs in those panels are not
clipped to three lines. Colors continue to come from the editor theme.
