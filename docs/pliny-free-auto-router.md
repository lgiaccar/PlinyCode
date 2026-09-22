# Pliny free model probe

Measured against the live gateway on 2026-09-22, 1 run(s) per model.
Regenerate with:

```sh
PLINY_API_KEY=... bun apps/vscode/scripts/probe-pliny-free-models.ts --runs 3
```

"Tool rate" is the fraction of runs in which the model actually emitted a tool
call when given one — the single most important property for agentic use, and
the reason a model with a great token rate may still be a poor default.

| Model | Context | Health | Tool rate | TTFT (median) | tok/s (median) |
| --- | --- | --- | --- | --- | --- |
| `snps-provider/qwen3-6-35b-a3b-1-28dd3` | 128k | healthy | 0 | 284 ms | 167.1 |
| `snps-provider/qwen3-coder-480b-a35b-inst-fp8` | 128k | healthy | 1 | 356 ms | 18 |
| `snps-provider/nemotron-3-ultra-550b-a55` | 200k | healthy | 1 | 358 ms | 64.6 |
| `snps-provider/qwen3-next-80b-a3b-instruct-d79b4` | 32k | healthy | 1 | 382 ms | 38.8 |
| `snps-provider/gemma-4-31b-it-29cea` | 128k | healthy | 1 | 408 ms | 20.9 |
| `snps-provider/llama-3-3-70b-instruct-128k` | 128k | healthy | 1 | 408 ms | 26.5 |
| `snps-provider/llama-3-3-70b-instruct-74k-ae1a8` | 74k | healthy | 1 | 454 ms | 19.5 |
| `snps-provider/nim-llama-3-3-70b-instruct-a7786` | 131k | healthy | 1 | 457 ms | 27.9 |
| `snps-provider/llama-3-1-70b-instruct-20ad2` | 32k | healthy | 1 | 460 ms | 15.3 |
| `snps-provider/nvidia-nemotron-3-super-120b-a12` | 256k | healthy | 1 | 553 ms | 42 |
| `snps-provider/qwen2-5-32b-instruct-fe66b` | 64k | healthy | 1 | 599 ms | 37.7 |
| `snps-provider/qwen3.5-397b-fp8` | 220k | healthy | 1 | 635 ms | 22.9 |
| `snps-provider/gemma-4-31b-it-1-reasoning` | 256k | healthy | 1 | 783 ms | 24.1 |
| `snps-provider/kimi-k2.6` | 256k | healthy | 1 | 791 ms | 86.6 |
| `snps-provider-internal-tests/glm-5-2` | 512k | healthy | 1 | 855 ms | 26 |
| `snps-provider/qwen3-8-27b` | 256k | healthy | 1 | 975 ms | 16.4 |
| `snps-provider-vmodels/glm-5.2` | 512k | healthy | 1 | 1058 ms | 28.4 |
| `snps-provider/GLM-5.2` | 512k | healthy | 1 | 1279 ms | 7.6 |
| `snps-provider/qwen3-6-27b` | 256k | healthy | 1 | 1750 ms | 19.2 |
| `snps-provider/qwen3-6-27b-ft` | 128k | healthy | 1 | 1990 ms | 12.1 |
| `snps-provider-sia/qwen3-8-27b-sia` | 256k | **down** | 0 | — | — |
| `snps-provider-sia/qwen3-5-397b-a17b-sia` | 220k | **down** | 0 | — | — |

## How this feeds the router

The default pool order in the generated rules file favours, in order: models
that answer reliably, models that really call tools, then latency. A model that
shows as **down** here is still left in the catalog (it may recover), but the
router benches it automatically after repeated failures at runtime.

## Trying it

FreeAuto is the default model, so a fresh install needs no setup. To run the
extension from source in Cursor or VS Code:

```powershell
pwsh apps/vscode/scripts/run-extension-host.ps1 -Editor cursor
```

Open the rules file from the command palette with **PlinyCode: Open FreeAuto
Routing Rules**. It is created on first activation, and saving it takes effect
on the next call without a restart.

Each call adds a timestamped row to the chat naming the model and the route that
chose it, and the end of every turn adds a summary. The same lines go to the
PlinyCode output channel.

To watch a failover happen, put a model that is currently down at the front of a
route's `use` list (the matrix above marks them) and send a message: the row
shows the failure and the model that took over, and the turn still completes.

## Regenerating the probe outside the editor

The gateway's certificate chain includes an intermediate that is not in the
Windows root store. The extension is unaffected because it inherits the editor's
OS trust store, but a standalone `bun` run needs the chain passed explicitly:

```powershell
$env:NODE_EXTRA_CA_CERTS = "<path to a PEM with the server, SNPSica2 and SNPSOfflineCA certs>"
bun apps/vscode/scripts/probe-pliny-free-models.ts --runs 3
```

Without it every model reports `unable to verify the first certificate`, which
looks like a total outage but is purely local trust configuration.
