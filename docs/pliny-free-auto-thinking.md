# Pliny free model thinking probe

Measured against the live gateway on 2026-09-24, 1 run(s) per variant.
Regenerate with:

```sh
PLINY_API_KEY=... bun apps/vscode/scripts/probe-pliny-free-models.ts --thinking --runs 2
```

Each cell is the number of reasoning characters the model produced for a short
trick question (reasoning deltas, or an inline `<think>` block), with billed
reasoning tokens in brackets when the gateway reports them. `✗ 400` means the
gateway rejected that request field outright.

| Model | Verdict | baseline | effort-high | template-on | effort-none | template-off | reasoning-exclude |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `snps-provider/GLM-5.2` | on by default · off via `template-kwargs` | 784 | 1102 | 1020 | 0 | 0 | 1130 |
| `snps-provider-internal-tests/glm-5-2` | on by default · off via `template-kwargs` | 842 | 635 | 1050 | 0 | 0 | 1074 |
| `snps-provider-vmodels/glm-5.2` | on by default · off via `template-kwargs` | 1003 | 694 | 995 | 0 | 0 | 1172 |
| `snps-provider/kimi-k2.6` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/nvidia-nemotron-3-super-120b-a12` | on by default · off via `template-kwargs` | 371 | 232 | 296 | 0 | 0 | 346 |
| `snps-provider/qwen3-8-27b` | on by default · off via `template-kwargs` | 236 | ✗ 400 | 240 | 0 | 0 | 352 |
| `snps-provider/qwen3-6-27b` | on by default · off via `template-kwargs` | 1166 | 1006 | 875 | 0 | 0 | 1142 |
| `snps-provider-sia/qwen3-8-27b-sia` | on by default · off via `template-kwargs` | 151 (58 tok) | ✗ 400 | 259 (104 tok) | 0 | 0 | 309 (91 tok) |
| `snps-provider/gemma-4-31b-it-1-reasoning` | off by default · on via `reasoning-effort` | 0 | 444 (225 tok) | 483 (226 tok) | 0 | 0 | 0 |
| `snps-provider/qwen3.5-397b-fp8` | on by default · off via `template-kwargs` | 1011 | 1012 | 1038 | 1034 | 0 | 1009 |
| `snps-provider-sia/qwen3-5-397b-a17b-sia` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/nemotron-3-ultra-550b-a55` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/nim-llama-3-3-70b-instruct-a7786` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/qwen3-coder-480b-a35b-inst-fp8` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/qwen3-6-27b-ft` | on by default · off via `template-kwargs` | 1103 | 1051 | 1057 | 0 | 0 | 1077 |
| `snps-provider/qwen3-6-35b-a3b-1-28dd3` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/gemma-4-31b-it-29cea` | off by default · on via `template-kwargs` | 0 | 0 | 448 | 0 | 0 | 0 |
| `snps-provider/llama-3-3-70b-instruct-128k` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/llama-3-3-70b-instruct-74k-ae1a8` | never | 0 | 0 | 0 | 0 | 0 | 0 |
| `snps-provider/qwen2-5-32b-instruct-fe66b` | never | 0 | ✗ 400 | 0 | ✗ 400 | 0 | ✗ 400 |
| `snps-provider/qwen3-next-80b-a3b-instruct-d79b4` | never | 0 | 0 | 0 | ✗ 400 | 0 | 0 |
| `snps-provider/llama-3-1-70b-instruct-20ad2` | never | 0 | ✗ 400 | 0 | ✗ 400 | 0 | ✗ 400 |

## How this feeds the router

The verdict is copied into each model's `thinking` entry in
`sdk/packages/llms/src/providers/data/pliny-models.json`. FreeAuto's `quick`
routes then turn reasoning off only on models with a known off-switch, and its
`think` routes turn it on only on models with a known on-switch, so an
unsupported field is never sent.
