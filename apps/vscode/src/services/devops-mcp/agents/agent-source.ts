import { execFile } from "node:child_process"
import path from "node:path"
import type { AgentMonitorConfig, MonitoredAgent } from "@/shared/agent-monitor"
import { adoAuth, type EditorTokenSource } from "../server/auth"
import { parseRemote } from "../server/repo"

export function agentQueueTarget(value: string) {
	let url: URL
	try {
		url = new URL(value.trim())
	} catch {
		throw new Error("Paste the Azure DevOps project agent-pool URL, including ?queueId=….")
	}
	const match = /^(.*)\/([^/]+)\/_settings\/agentqueues\/?$/.exec(url.pathname)
	const queueId = Number(url.searchParams.get("queueId"))
	if (url.protocol !== "https:" || url.username || url.password || !match || !Number.isSafeInteger(queueId) || queueId <= 0) {
		throw new Error("Use an HTTPS project agent-pool URL with a positive queueId and no embedded credentials.")
	}
	const collectionUrl = `${url.origin}${match[1]}`
	const projectUrl = `${collectionUrl}/${match[2]}`
	const queueUrl = `${projectUrl}/_settings/agentqueues?queueId=${queueId}&view=agents`
	return {
		queueUrl,
		collectionUrl,
		queueApi: `${projectUrl}/_apis/distributedtask/queues/${queueId}?api-version=7.1`,
		remote: parseRemote(`${projectUrl}/_git/_agent_monitor`),
	}
}

/** Only capability names and an allowlisted OS leave the transport; values can contain secrets. */
interface AgentRecord {
	id: number
	name: string
	status: string
	enabled: boolean
	busy: boolean
	capabilities: string[]
	jobName: string
	jobUrl: string
	pipelineName: string
	runName: string
	definitionUrl: string
	planType: string
	scopeId: string
	ownerId: number
	os: MonitoredAgent["os"]
}

export interface AgentPoolSnapshot {
	poolName: string
	poolId?: number
	agents: MonitoredAgent[]
}

function safeJobUrl(value: string, queueUrl: string): string {
	try {
		const url = new URL(value)
		return url.origin === new URL(queueUrl).origin && !url.username && !url.password ? url.href : ""
	} catch {
		return ""
	}
}

function normalizePool(pool: { poolName: string; poolId: number; agents: AgentRecord[] }, queueUrl: string): AgentPoolSnapshot {
	if (!Array.isArray(pool.agents)) throw new Error("Azure DevOps returned an invalid agent list.")
	return {
		poolName: pool.poolName,
		poolId: pool.poolId,
		agents: pool.agents.map((agent) => {
			const { definitionUrl, planType, scopeId, ownerId, ...details } = agent
			// A shared pool can run jobs from another project: use the request's scope, not the queue's project.
			const runUrl =
				planType === "build" && /^[0-9a-f-]{36}$/i.test(scopeId) && Number.isSafeInteger(ownerId) && ownerId > 0
					? `${agentQueueTarget(queueUrl).collectionUrl}/${scopeId}/_build/results?buildId=${ownerId}`
					: ""
			return {
				...details,
				status: agent.status === "online" || agent.status === "offline" ? agent.status : "unknown",
				capabilities: [...new Set(agent.capabilities)].sort(),
				url: `${queueUrl}&agentId=${agent.id}`,
				jobUrl: safeJobUrl(agent.jobUrl, queueUrl) || runUrl || safeJobUrl(definitionUrl, queueUrl),
			}
		}),
	}
}

// Fixed program, not a shell command assembled from URLs. Input is JSON on stdin.
// Windows PowerShell ships with Windows; no browser cookies or passwords are read.
export const WINDOWS_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $queue = Invoke-RestMethod -Uri $inputData.queueApi -UseDefaultCredentials -MaximumRedirection 0 -TimeoutSec 20
  $poolId = [long]$queue.pool.id
  if ($poolId -le 0) { throw 'Invalid agent pool' }
  $agentsUrl = $inputData.collectionUrl + '/_apis/distributedtask/pools/' + $poolId + '/agents?api-version=7.1&includeCapabilities=true&includeAssignedRequest=true'
  $response = Invoke-RestMethod -Uri $agentsUrl -UseDefaultCredentials -MaximumRedirection 0 -TimeoutSec 20
  if ($null -eq $response.value) { throw 'Invalid agent list' }
  $agents = @($response.value | ForEach-Object {
    $capabilities = @($_.systemCapabilities.PSObject.Properties.Name) + @($_.userCapabilities.PSObject.Properties.Name)
    $os = switch -Exact ($_.systemCapabilities.'Agent.OS') { 'Windows_NT' { 'windows' }; 'Linux' { 'linux' }; 'Darwin' { 'macos' }; default { 'unknown' } }
    @{
      id = $_.id; name = $_.name; status = $_.status; enabled = [bool]$_.enabled
      os = $os
      busy = ($null -ne $_.assignedRequest)
      capabilities = @($capabilities | Where-Object { $_ } | Sort-Object -Unique)
      pipelineName = [string]$_.assignedRequest.definition.name
      runName = [string]$_.assignedRequest.owner.name
      jobName = [string]$_.assignedRequest.jobName
      jobUrl = [string]$_.assignedRequest.owner._links.web.href
      definitionUrl = [string]$_.assignedRequest.definition._links.web.href
      planType = [string]$_.assignedRequest.planType
      scopeId = [string]$_.assignedRequest.scopeId
      ownerId = [long]$_.assignedRequest.owner.id
    }
  })
  @{poolName = [string]$queue.pool.name; poolId = $poolId; agents = $agents} | ConvertTo-Json -Depth 8 -Compress
} catch {
  $status = 0
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  @{error = 'Windows sign-in could not read this agent pool. Check network/VPN access and agent-pool read permission, or select Personal access token.'; status = $status} | ConvertTo-Json -Compress
  exit 1
}
`

async function readWindowsAgentPool(queueUrl: string): Promise<AgentPoolSnapshot> {
	if (process.platform !== "win32")
		throw new Error("Windows sign-in requires a local Windows extension host. Select Personal access token on this host.")
	const target = agentQueueTarget(queueUrl)
	const executable = path.join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	)
	return new Promise((resolve, reject) => {
		const child = execFile(
			executable,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(WINDOWS_QUERY, "utf16le").toString("base64"),
			],
			{ windowsHide: true, timeout: 50_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				try {
					const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ""))
					if (result.error) throw new Error(`${result.error}${result.status ? ` (HTTP ${result.status})` : ""}`)
					if (error) throw new Error("Windows agent query failed or timed out.")
					resolve(normalizePool(result, target.queueUrl))
				} catch (failure) {
					reject(
						failure instanceof SyntaxError
							? new Error("Windows agent query failed. Windows PowerShell may be unavailable or restricted.")
							: failure,
					)
				}
			},
		)
		child.stdin?.on("error", () => {}) // execFile's callback reports process failures.
		child.stdin?.end(JSON.stringify({ queueApi: target.queueApi, collectionUrl: target.collectionUrl }))
	})
}

export async function readAgentPool(config: AgentMonitorConfig, editorToken: EditorTokenSource): Promise<AgentPoolSnapshot> {
	if (config.authentication === "windows") return readWindowsAgentPool(config.queueUrl)
	const target = agentQueueTarget(config.queueUrl)
	const auth = adoAuth(target.remote, editorToken)
	const get = async (url: string) => {
		for (const attempt of [0, 1]) {
			const response = await fetch(url, {
				headers: { Authorization: await auth.header(), Accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.timeout(25_000),
			})
			if (response.status === 401 && attempt === 0) {
				auth.invalidate()
				await response.body?.cancel()
				continue
			}
			if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) {
				await response.body?.cancel()
				throw new Error(
					`Agent-pool request failed (HTTP ${response.status}). Check the token and agent-pool read permission.${response.status === 401 ? ` ${auth.rejectedHint ?? ""}` : ""}`,
				)
			}
			return response.json()
		}
		throw new Error("Agent-pool authentication failed.")
	}
	const queue = await get(target.queueApi)
	if (!Number.isSafeInteger(queue.pool?.id) || queue.pool.id <= 0) throw new Error("This queue has no associated agent pool.")
	const response = await get(
		`${target.collectionUrl}/_apis/distributedtask/pools/${queue.pool.id}/agents?api-version=7.1&includeCapabilities=true&includeAssignedRequest=true`,
	)
	if (!Array.isArray(response.value)) throw new Error("Azure DevOps returned an invalid agent list.")
	return normalizePool(
		{
			poolName: queue.pool.name ?? queue.name,
			poolId: queue.pool.id,
			agents: response.value.map((agent: any) => ({
				id: agent.id,
				name: agent.name,
				status: agent.status,
				enabled: Boolean(agent.enabled),
				busy: Boolean(agent.assignedRequest),
				os:
					agent.systemCapabilities?.["Agent.OS"] === "Windows_NT"
						? "windows"
						: agent.systemCapabilities?.["Agent.OS"] === "Linux"
							? "linux"
							: agent.systemCapabilities?.["Agent.OS"] === "Darwin"
								? "macos"
								: "unknown",
				capabilities: Object.keys({ ...agent.systemCapabilities, ...agent.userCapabilities }),
				pipelineName: agent.assignedRequest?.definition?.name ?? "",
				runName: agent.assignedRequest?.owner?.name ?? "",
				jobName: agent.assignedRequest?.jobName ?? "",
				jobUrl: agent.assignedRequest?.owner?._links?.web?.href ?? "",
				definitionUrl: agent.assignedRequest?.definition?._links?.web?.href ?? "",
				planType: agent.assignedRequest?.planType ?? "",
				scopeId: agent.assignedRequest?.scopeId ?? "",
				ownerId: Number(agent.assignedRequest?.owner?.id),
			})),
		},
		target.queueUrl,
	)
}
