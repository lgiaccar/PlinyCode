import { mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { expect } from "@playwright/test"
import { e2e } from "./utils/helpers"

e2e("Grafana - secure setup and machine queries through the packaged backend", async ({ helper, sidebar, page }) => {
	const queries: { expr: string; range: boolean }[] = []
	const server = createServer(async (request, response) => {
		response.setHeader("content-type", "application/json")
		if (request.headers.authorization !== "Bearer grafana-e2e-fixture") {
			response.writeHead(401)
			response.end("{}")
			return
		}
		if (request.url?.startsWith("/api/search?")) {
			response.end(JSON.stringify([{ uid: "machines", title: "Machine resources" }]))
		} else if (request.url === "/api/dashboards/uid/machines") {
			response.end(
				JSON.stringify({
					dashboard: {
						panels: [
							{
								id: 1,
								title: "CPU percent",
								datasource: { type: "prometheus" },
								fieldConfig: { defaults: { unit: "percent" } },
								targets: [{ expr: 'cpu_load{host="$host"}' }],
							},
						],
					},
				}),
			)
		} else if (request.url === "/api/datasources") {
			response.end(JSON.stringify([{ uid: "metrics", type: "prometheus", isDefault: true }]))
		} else if (request.url === "/api/datasources/uid/metrics") {
			response.end(JSON.stringify({ type: "prometheus" }))
		} else if (request.url === "/api/ds/query" && request.method === "POST") {
			let body = ""
			for await (const chunk of request) body += chunk.toString()
			const data = JSON.parse(body)
			queries.push(data.queries[0])
			response.end(
				JSON.stringify({
					results: {
						Q0: {
							frames: [
								{
									schema: {
										name: "CPU",
										fields: [
											{ name: "Time", type: "time" },
											{ name: "Value", type: "number", labels: { host: "build-01" } },
										],
									},
									data: {
										values: [
											[Number(data.from), Number(data.to)],
											[20, 60],
										],
									},
								},
							],
						},
					},
				}),
			)
		} else {
			response.writeHead(404)
			response.end("{}")
		}
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	try {
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("Missing fixture server port")
		await helper.ensureReady(sidebar)
		await page.getByRole("button", { name: "Pipelines", exact: true }).click()
		await sidebar.getByRole("button", { name: "Agents", exact: true }).click()
		await sidebar.getByRole("button", { name: "Grafana machine metrics…" }).click()
		await expect(sidebar.getByLabel("Grafana server URL")).toHaveValue("")
		await sidebar.getByLabel("Grafana server URL").fill(`http://127.0.0.1:${address.port}`)
		await expect(sidebar.getByLabel("Dashboard UID")).toBeHidden()
		await sidebar.getByRole("button", { name: "Enter token and connect…" }).click()
		const password = page.locator('.quick-input-widget input[type="password"]')
		await expect(password).toBeVisible()
		await password.fill("grafana-e2e-fixture")
		await password.press("Enter")
		await expect(password).toBeHidden()
		await expect(sidebar.getByText(/A token is stored for the saved server/)).toBeVisible()
		await expect(sidebar.getByText(/Connected. Dashboard and metric panels/)).toBeVisible()
		await expect(sidebar.getByText(/Available: CPU load/)).toBeVisible()
		await sidebar.getByRole("button", { name: "Advanced setup", exact: true }).click()
		await sidebar.getByRole("button", { name: "Test a machine" }).click()
		await sidebar.getByLabel("Grafana host", { exact: true }).fill("build-01")
		await sidebar.getByRole("button", { name: "Load metrics", exact: true }).click()
		await expect(sidebar.getByText("Sample average 40.0% · Peak 60.0% · P95 60.0%")).toBeVisible({ timeout: 15000 })
		expect(queries[0]).toMatchObject({ expr: 'cpu_load{host="build-01"}', range: true })
		await expect(sidebar.getByRole("combobox", { name: /^Time range/ })).toHaveValue("30d")
		await sidebar.getByRole("combobox", { name: /^Time range/ }).selectOption("1w")
		await expect(sidebar.getByRole("button", { name: "Load metrics", exact: true })).toBeEnabled()
		await expect.poll(() => queries.length).toBe(2)
		await sidebar
			.getByRole("img", { name: "CPU load over the selected time range, 0 to 100 percent" })
			.scrollIntoViewIfNeeded()
		await mkdir(path.resolve("../../ai_output"), { recursive: true })
		await page.screenshot({ path: path.resolve("../../ai_output/grafana-metrics-e2e.png") })
		await sidebar.getByRole("button", { name: "Remove token", exact: true }).click()
		await expect(sidebar.getByText(/No token stored for the saved server/)).toBeVisible()
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})
