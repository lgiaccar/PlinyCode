# Pliny API keys

PlinyCode sends every model request to the Pliny gateway with an API key.
Keys can be added in Settings, or come from the `PLINY_API_KEY` environment
variable as before.

## Adding keys in Settings

**Settings → API Configuration → Pliny API Keys** lists the stored keys:
- Each row shows a status light, the key's nickname and its last four characters (`••••1a2b`).
- One key is marked **Active**; every other row has a **Use** button.
- Each row also has **Test**, **Rename** and **Remove**.

**Adding a key.** Everything happens in the Settings page:
1. Click **Add Key**. A form opens under the list.
2. Type a **Nickname** (for example *Personal* or *Team budget*). Every key needs one, and it must differ from the other keys' nicknames (case is ignored). The first key is offered *Default*.
3. Paste the **API key** into the password field. The eye button shows what you pasted.
4. Optionally click **Test** to check the key before storing it.
5. Click **Save** (or press Enter). **Cancel** (or Escape) closes the form.

**Renaming** turns the row's nickname into a text field: Enter or ✓ saves, Escape or ✕ cancels.

**The check on Save.** Before storing the key, PlinyCode asks the gateway's budget endpoint about it:
- If the gateway rejects it (HTTP 401/403), the form says so and keeps what you typed.
- If the gateway cannot be reached, the key is stored unchecked.
- A key that is already stored, under any name, is refused.

**Where the key travels.** A key typed in the form goes from the Settings
webview to the extension once, over the extension's own message channel,
when you click Test or Save. Only the extension holds it after that: the list
the webview receives has only nicknames and last four characters, and
testing a stored key sends its id, not the key.

## Testing a key

**Test**, on a stored key's row or in the add form, sends one real request
to the Pliny inference server with that key: a chat completion of at most
one token (`POST <baseUrl>/chat/completions`) to a free model, the router
rules' `commit` utility model (the one Improve prompt uses). It costs nothing
and checks what a conversation needs: the key, the network path and a model
answering. The request gives up after 30 seconds.

The light next to the key shows the result:

| Light | Meaning |
| --- | --- |
| Grey | Not tested since Settings was opened |
| Spinner | The test is running |
| Green | The server answered; the tooltip and the line under the form give the time it took |
| Red | The gateway rejected the key (HTTP 401/403), answered another error (the gateway's message is shown), or could not be reached |

Results are not stored; they last until Settings is closed.

The first key you add becomes the active one. Removing the active key makes
the next one in the list active.

## Where they are stored

Keys live in the editor's SecretStorage, which is the OS keychain:
- Windows Credential Manager (DPAPI)
- macOS Keychain
- the Secret Service on Linux

They are encrypted at rest and shared by every window of the same editor profile.

| SecretStorage key | Holds |
| --- | --- |
| `plinycode.plinyApiKeys` | The list (id, name, last four characters, creation time) and the active id, as one JSON value. A write therefore never leaves them disagreeing. |
| `plinycode.plinyApiKey:<id>` | One key. |

Nothing is written to `providers.json` or PlinyCode's state files. The
[diagnostics bundle](diagnostics-bundle.md) never reads SecretStorage.

## Which key a request uses

PlinyCode takes the first of these that exists:
1. **The active key from Settings.**
2. **`providers.json`.** The `apiKey` in the Pliny entry of `<dataDir>/settings/providers.json`. Older installs and the e2e tests use it.
3. **`PLINY_API_KEY`.** The environment variable of the extension host. The engine reads it as the Pliny provider's `apiKeyEnv`.

The order is the same for everything that calls the gateway:
- chat and sub-agents;
- the FreeAuto and BalanceAuto routers;
- compaction, commit messages and memory distillation;
- the model catalog;
- the budget indicator.

Settings says which source is in use when no key is stored. The log names
the source of each session's key as `keySource=settings|providers.json|PLINY_API_KEY|none`.
It never logs the key.

**How the code finds the key.** Provider configs are built synchronously, so
`hosts/vscode/pliny-api-keys.ts` keeps the active key in memory and registers
itself with `sdk/pliny-api-key-source.ts` at activation. Two functions overlay
that key:
- `buildEffectiveProviderConfig` (`sdk/model-catalog/effective-config.ts`), which covers the catalog and the budget;
- `resolveApiKey` (`sdk/cline-session-factory.ts`), which covers sessions and standalone handlers.

A session build first waits up to 2 seconds for the keychain read, so a task
restored at startup does not fall back to `PLINY_API_KEY` by mistake.

## Changing the active key

The engine's provider reads its key once, when the session is built. When
the active key changes, in any window, each window does two things:
- **Rebuilds its open conversation.** This happens once it is idle, through the same restart the terminal execution mode uses (`SdkTerminalExecutionModeCoordinator`, rebuild reason `providerCredentials`).
- **Refetches the budget indicator.**

A task already running keeps its key until its turn ends. Background tasks
keep theirs until they finish.

## Switching keys when one stops working

`hosts/vscode/pliny-key-failover.ts` watches every model request that fails
for good: the open task's, a background task's and a sub-agent's.

**When it offers a switch.** Only when the active key came from Settings, in two cases:
- **Rejected.** The gateway rejected the key (the engine classed the error as `auth`, i.e. HTTP 401/403).
- **Budget used up.** The budget endpoint says the key's budget is used up:
  - its budget is blocked, or
  - nothing is left under an enforced rule.

  A failed request does not say reliably that the budget ran out, so for any
  other failure PlinyCode asks the endpoint, at most once a minute.

**What it asks.** A warning such as *The Pliny gateway rejected the API key "Personal". Switch to "Team" and click Retry?*
- **Switch to "Team"** makes that key active, and clicking Retry on the failed request then uses it.
- **Manage Keys** opens Settings.

It never switches by itself, because a switch changes whose budget pays.

**How often it asks.** Each key and reason is offered once per window. Once
every stored key has failed, the warning offers only **Manage Keys**. Making a
key active again gives it a fresh chance.

The error row in the chat points at the same place: *Add another key or
switch the active one under Settings → API Configuration → Pliny API Keys*.

## Scripts

The scripts under `sdk/scripts/eval` and `apps/vscode/scripts/` (the eval
harness, the probes) run outside VS Code and still read only `PLINY_API_KEY`.
