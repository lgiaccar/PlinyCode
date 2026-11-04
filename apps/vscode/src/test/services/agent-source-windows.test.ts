import { expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { WINDOWS_QUERY } from "@/services/devops-mcp/agents/agent-source"

it.skipIf(process.platform !== "win32")(
	"Windows transport returns pipeline, run and job details without capability values",
	() => {
		// Execute the production script, replacing only HTTP with an in-process fixture.
		const fixture = `
function Invoke-RestMethod {
  param($Uri, [switch]$UseDefaultCredentials, $MaximumRedirection, $TimeoutSec)
  if ($Uri -like '*/queues/*') { return @{pool = @{id = 99; name = 'Shared pool'}} }
  return @{value = @(
    @{id = 1; name = 'worker'; status = 'online'; enabled = $true; systemCapabilities = [pscustomobject]@{BUILD_CPU = 'private-value'}; assignedRequest = @{
      definition = @{name = 'Build pipeline'}; owner = @{id = 123; name = '20261104.1'; _links = @{web = @{href = 'https://server.example/run/123'}}}; jobName = 'Compile'; planType = 'build'; scopeId = '11111111-2222-3333-4444-555555555555'
    }},
    @{id = 2; name = 'idle'; status = 'online'; enabled = $true}
  )}
}
`
		const stdout = execFileSync(
			path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(fixture + WINDOWS_QUERY, "utf16le").toString("base64"),
			],
			{
				input: JSON.stringify({ queueApi: "https://server.example/queues/21", collectionUrl: "https://server.example" }),
				encoding: "utf8",
				windowsHide: true,
				timeout: 20_000,
			},
		)
		const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ""))
		expect(result.agents[0]).toMatchObject({
			busy: true,
			pipelineName: "Build pipeline",
			runName: "20261104.1",
			jobName: "Compile",
			jobUrl: "https://server.example/run/123",
			ownerId: 123,
			capabilities: ["BUILD_CPU"],
		})
		expect(result.agents[1]).toMatchObject({ busy: false, pipelineName: "", runName: "", jobName: "", jobUrl: "" })
		expect(stdout).not.toContain("private-value")
	},
	25_000,
)
