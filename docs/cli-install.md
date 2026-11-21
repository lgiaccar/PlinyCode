# Download and use the PlinyCode CLI

The CLI runs in a terminal, Python script or existing YAML pipeline. You do not
need VS Code, Node or Bun: the download includes its runtime. You need a Pliny API
key and network access to the Synopsys Pliny gateway to use models.

## Download

[PlinyCode CLI 0.1.0 downloads](https://github.com/lgiaccar/PlinyCode/releases/tag/cli-v0.1.0)
are public and do not require GitHub sign-in. Choose your platform:

| Platform | Download |
| --- | --- |
| Windows x64 | [PlinyCode-CLI-0.1.0-windows-x64.zip](https://github.com/lgiaccar/PlinyCode/releases/download/cli-v0.1.0/PlinyCode-CLI-0.1.0-windows-x64.zip) |
| Linux x64 (Ubuntu 22.04/24.04) | [PlinyCode-CLI-0.1.0-linux-x64.tar.gz](https://github.com/lgiaccar/PlinyCode/releases/download/cli-v0.1.0/PlinyCode-CLI-0.1.0-linux-x64.tar.gz) |
| Archive checksums | [SHA256SUMS](https://github.com/lgiaccar/PlinyCode/releases/download/cli-v0.1.0/SHA256SUMS) |

Download `SHA256SUMS` beside the archive. Keep the entire extracted folder,
including `runtime/`. These are portable packages, not installers. macOS and ARM64
packages are not included. Linux distributions other than Ubuntu are not tested.

## Windows: install and start

Open PowerShell in the folder containing the downloads. Verify the ZIP:

```powershell
$archive = 'PlinyCode-CLI-0.1.0-windows-x64.zip'
$line = Get-Content .\SHA256SUMS | Where-Object { $_.EndsWith("  $archive") }
if (@($line).Count -ne 1) { throw 'Missing or duplicate archive checksum' }
$expected = ($line -split '\s+')[0]
if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $expected) { throw 'Checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath .\PlinyCodeCLI-0.1.0
cd .\PlinyCodeCLI-0.1.0\plinycode-windows-x64
.\plinycode.cmd doctor
.\plinycode.cmd auth login
.\plinycode.cmd chat
```

`auth login` prompts for the key without displaying it and stores it encrypted for
your Windows account. Do not put the key directly in a command argument.

To run `plinycode` from any folder, move the extracted directory to a permanent
location and add the directory **containing `plinycode.cmd`** to your user `Path`
using Windows **Edit environment variables for your account**. Open a new terminal.
You can also use the full path to `plinycode.cmd` without changing PATH.

## Linux: install and start

In the folder containing the downloads:

```bash
grep '  PlinyCode-CLI-0.1.0-linux-x64.tar.gz$' SHA256SUMS | sha256sum --check
# Continue only if verification reports OK.
mkdir -p "$HOME/.local/opt/plinycode-cli/0.1.0"
tar -xzf PlinyCode-CLI-0.1.0-linux-x64.tar.gz -C "$HOME/.local/opt/plinycode-cli/0.1.0"
export PATH="$HOME/.local/opt/plinycode-cli/0.1.0/plinycode-linux-x64:$PATH"
plinycode doctor
plinycode auth login
plinycode chat
```

Add the `export PATH=...` line to your shell startup file to keep it across terminal
sessions. Extracting the tarball preserves executable permissions. Add the package
directory to PATH directly; do not move the launcher away from `runtime/`.

Saving credentials on Linux requires an unlocked Secret Service keyring and
`secret-tool` (`sudo apt install libsecret-tools` on Ubuntu desktops). On SSH hosts
or CI without a keyring, inject `PLINY_API_KEY` through your environment or secret
manager instead. It takes precedence over saved credentials. `plinycode auth logout`
removes a saved key; it does not unset an environment variable.

## Everyday use

Run from the project folder you want the agent to work in:

```sh
plinycode chat
plinycode models
plinycode run --prompt "Summarize these test failures" --file test-results.log --json
```

Omitting `--model` selects **FreeAuto**. Use `--model <id>` to select a concrete
model. Type `/exit` to leave chat; Ctrl+C cancels the current process. Edits,
commands and MCP actions ask for approval in chat. Unattended runs deny those
actions unless you explicitly pass `--allow-tools`.

`doctor` checks the runtime and optional tools without calling the model gateway.
Git, Python, ripgrep and external MCP programs are separate job dependencies; the
CLI does not install them. See the [full CLI guide](cli.md) for schemas, files,
generated reports, MCP transports, proxy/certificate setup and exit codes.

## GitHub Actions example

This example installs the published Linux CLI, verifies its checksum and analyses
an existing test log. Supply your API key as the `PLINY_API_KEY` repository secret.

```yaml
- name: Download PlinyCode CLI
  shell: bash
  run: |
    set -euo pipefail
    version=0.1.0
    base="https://github.com/lgiaccar/PlinyCode/releases/download/cli-v${version}"
    archive="PlinyCode-CLI-${version}-linux-x64.tar.gz"
    mkdir -p "$RUNNER_TEMP/plinycode-cli"
    cd "$RUNNER_TEMP/plinycode-cli"
    curl --fail --location "$base/$archive" --output "$archive"
    curl --fail --location "$base/SHA256SUMS" --output SHA256SUMS
    grep "  ${archive}$" SHA256SUMS | sha256sum --check
    tar -xzf "$archive"
    echo "$PWD/plinycode-linux-x64" >> "$GITHUB_PATH"
- name: Analyse test log
  if: always()
  shell: bash
  env:
    PLINY_API_KEY: ${{ secrets.PLINY_API_KEY }}
  run: |
    plinycode run --prompt "Explain these test failures and cite evidence" \
      --file test-results.log --json > judgement.json
```

Place the analysis step after the steps producing `test-results.log`. Python and
Azure DevOps use the same executable and environment variable. A failed test
judgement is different from a failed CLI execution; inspect the JSON result when
deciding whether to fail a pipeline.

## Update or remove

Download and verify the next CLI release into a new directory, then update PATH.
The CLI does not automatically update. To remove it, remove its directory and PATH
entry; run `auth logout` first if you also want to remove the stored credential.
The CLI release is independent of the extension's version and auto-updater.
