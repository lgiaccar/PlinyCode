import { createHash } from "node:crypto"
import {
	type GrafanaConfig,
	type GrafanaSetup,
	type MachineMetrics,
	METRIC_RANGES,
	type MetricRange,
} from "@shared/grafana-metrics"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { GrafanaClient, validateGrafanaConfig, validateMetricHost } from "@/services/grafana/client"

let secrets: vscode.SecretStorage | undefined
export function setGrafanaSecrets(value: vscode.SecretStorage | undefined): void {
	secrets = value
}
function secretKey(url: string): string {
	return `plinycode.grafana:${createHash("sha256").update(url).digest("hex")}`
}
function trusted(): void {
	if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before connecting to Grafana.")
}
function config(): GrafanaConfig {
	return StateManager.get().getGlobalStateKey("grafanaMetrics")
}
function store(): vscode.SecretStorage {
	if (!secrets) throw new Error("Grafana credential storage is not ready.")
	return secrets
}

export async function grafanaSettings(): Promise<GrafanaSetup> {
	const saved = config()
	return { config: saved, hasToken: Boolean(saved.url && (await store().get(secretKey(saved.url)))), panels: [] }
}
export async function configureGrafanaMetrics(value: GrafanaConfig): Promise<GrafanaSetup> {
	trusted()
	StateManager.get().setGlobalState("grafanaMetrics", validateGrafanaConfig(value))
	cache.clear()
	return grafanaSettings()
}
/** The credential never passes through the webview, RPC arguments or ordinary settings. */
export async function promptGrafanaToken(): Promise<GrafanaSetup> {
	trusted()
	const saved = validateGrafanaConfig(config())
	const token = await vscode.window.showInputBox({
		title: "PlinyCode: Grafana read/query token",
		prompt: `Token for ${saved.url}${saved.url.startsWith("http:") ? " — this server uses unencrypted HTTP" : ""}`,
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (!value.trim() || /\s/.test(value.trim()) ? "Enter a token without whitespace." : undefined),
	})
	if (token !== undefined) {
		await store().store(secretKey(saved.url), token.trim())
		cache.clear()
	}
	return grafanaSettings()
}
export async function removeGrafanaCredential(): Promise<GrafanaSetup> {
	trusted()
	if (config().url) await store().delete(secretKey(config().url))
	cache.clear()
	return grafanaSettings()
}
async function client() {
	trusted()
	const saved = validateGrafanaConfig(config())
	const token = await store().get(secretKey(saved.url))
	if (!token) throw new Error("Add a Grafana read/query token first. Browser sign-in is separate.")
	return { saved, identity: createHash("sha256").update(token).digest("hex"), connection: new GrafanaClient(saved, token) }
}
export async function inspectGrafanaDashboard(): Promise<GrafanaSetup> {
	const { saved, connection } = await client()
	return { config: saved, hasToken: true, panels: await connection.panels() }
}
const cache = new Map<string, { expires: number; value: Promise<MachineMetrics> }>()
export async function readGrafanaMetrics(host: string, range: string): Promise<MachineMetrics> {
	trusted()
	validateMetricHost(host)
	if (!Object.hasOwn(METRIC_RANGES, range)) throw new Error("Choose a supported time range.")
	const { saved, identity, connection } = await client()
	const key = JSON.stringify([saved, identity, host, range])
	const cached = cache.get(key)
	if (cached && cached.expires > Date.now()) return cached.value
	// A small bounded cache shares results for multiple agents on the same machine.
	if (cache.size >= 20) cache.delete(cache.keys().next().value as string)
	const value = connection.metrics(host, range as MetricRange)
	cache.set(key, { expires: Date.now() + 30_000, value })
	try {
		return await value
	} catch (error) {
		if (cache.get(key)?.value === value) cache.delete(key)
		throw error
	}
}
