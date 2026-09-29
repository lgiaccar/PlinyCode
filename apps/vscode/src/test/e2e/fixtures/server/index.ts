import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { v4 as uuidv4 } from "uuid"
import {
	E2E_MOCK_API_RESPONSES,
	E2E_MOCK_CLINE_MODELS,
	E2E_MOCK_CLINE_RECOMMENDED_MODELS,
	E2E_MOCK_EDITOR_TOOL_CALL,
	E2E_MOCK_POWERSHELL_TOOL_CALL,
	E2E_REGISTERED_MOCK_ENDPOINTS,
} from "./api"

const E2E_API_SERVER_PORT = 7777

export const MOCK_CLINE_API_SERVER_URL = `http://localhost:${E2E_API_SERVER_PORT}`

const useVerboseLogging = process.env.CLINE_E2E_TESTS_VERBOSE === "true"
function log(...args: unknown[]) {
	if (useVerboseLogging) {
		console.log("[ClineApiServerMock]", ...args)
	}
}

export class ClineApiServerMock {
	static globalSharedServer: ClineApiServerMock | null = null
	static globalSockets: Set<Socket> = new Set()

	public generationCounter = 0

	constructor(public readonly server: Server) {}

	// Helper to match routes against registered endpoints and extract parameters
	private static matchRoute(
		path: string,
		method: string,
	): {
		matched: boolean
		baseRoute?: string
		endpoint?: string
		params?: Record<string, string>
	} {
		for (const [baseRoute, methods] of Object.entries(E2E_REGISTERED_MOCK_ENDPOINTS)) {
			const methodEndpoints = methods[method as keyof typeof methods]
			if (!methodEndpoints) {
				continue
			}

			for (const endpoint of methodEndpoints) {
				const fullPattern = `${baseRoute}${endpoint}`
				const params: Record<string, string> = {}

				// Convert pattern like "/users/{userId}/balance" to a regex
				const regexPattern = fullPattern.replace(/\{([^}]+)\}/g, () => {
					return "([^/]+)"
				})

				const regex = new RegExp(`^${regexPattern}$`)
				const match = path.match(regex)

				if (match) {
					// Extract parameter names from the pattern
					const paramNames: string[] = []
					const paramRegex = /\{([^}]+)\}/g
					let paramMatch: RegExpExecArray | null = paramRegex.exec(fullPattern)
					while (paramMatch !== null) {
						paramNames.push(paramMatch[1])
						paramMatch = paramRegex.exec(fullPattern)
					}

					// Map captured groups to parameter names
					for (let i = 0; i < paramNames.length; i++) {
						params[paramNames[i]] = match[i + 1]
					}

					return {
						matched: true,
						baseRoute,
						endpoint,
						params,
					}
				}
			}
		}

		return { matched: false }
	}

	// Starts the global shared server
	public static async startGlobalServer(): Promise<ClineApiServerMock> {
		log("=== SERVER FIXTURE CALLED ===")
		if (ClineApiServerMock.globalSharedServer) {
			log("Using existing global server")
			return ClineApiServerMock.globalSharedServer
		}

		log("Starting global server...")
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			// Parse URL and method
			const parsedUrl = new URL(req.url || "/", MOCK_CLINE_API_SERVER_URL)
			const path = parsedUrl.pathname
			const query = Object.fromEntries(parsedUrl.searchParams.entries())
			const method = req.method || "GET"

			// Helper to read request body
			const readBody = (): Promise<string> => {
				return new Promise((resolve) => {
					let body = ""
					req.on("data", (chunk) => {
						body += chunk.toString()
					})
					req.on("end", () => resolve(body))
				})
			}

			// Helper to send JSON response
			const sendJson = (data: unknown, status = 200) => {
				res.writeHead(status, { "Content-Type": "application/json" })
				res.end(JSON.stringify(data))
			}

			const sendApiError = (error: string, status = 400) => {
				sendJson({ success: false, error }, status)
			}

			// The /api/v1 paths expect a bearer token. The /api/llm path is the Pliny
			// gateway surface: the openVSCode fixture seeds a dummy key for it, which
			// any bearer check would accept anyway.
			const authHeader = req.headers.authorization
			const isAuthRequired = path.startsWith("/api/v1/")
			if (isAuthRequired && (!authHeader || !authHeader.startsWith("Bearer "))) {
				return sendApiError("Unauthorized", 401)
			}

			log("=== MOCK SERVER REQUEST ===")
			log("Method:", method)
			log("Path:", path)
			log("Query:", JSON.stringify(query))
			log("Headers:", JSON.stringify(req.headers))
			log("===============")

			// Route handling
			const handleRequest = async () => {
				// Try to match the route using registered endpoints
				const routeMatch = ClineApiServerMock.matchRoute(path, method)

				if (!routeMatch.matched) {
					return sendJson({ error: "Not found" }, 404)
				}

				const { baseRoute, endpoint } = routeMatch
				const controller = ClineApiServerMock.globalSharedServer!

				// Health check endpoints
				if (baseRoute === "/health") {
					if (endpoint === "/" && method === "GET") {
						return sendJson({
							status: "ok",
							timestamp: new Date().toISOString(),
						})
					}
				}

				// API v1 endpoints
				if (baseRoute === "/api/v1") {
					if (endpoint === "/ai/cline/recommended-models" && method === "GET") {
						return sendJson(E2E_MOCK_CLINE_RECOMMENDED_MODELS)
					}

					if (endpoint === "/ai/cline/models" && method === "GET") {
						return sendJson({ data: E2E_MOCK_CLINE_MODELS })
					}

					// Chat completions endpoint
					if (endpoint === "/chat/completions" && method === "POST") {
						const body = await readBody()
						const parsed = JSON.parse(body)
						const { messages, model = "claude-3-5-sonnet-20241022", stream = true } = parsed

						// The SDK runtime executes structured tool calls and then sends a
						// follow-up /chat/completions request containing the tool result as
						// a `role: "tool"` message. Detect that follow-up first — the
						// original "edit_request" user prompt is still present in the
						// conversation history of the follow-up request, so order matters.
						// Scope tool-result routing to the mock scenarios that issued a tool
						// call so unrelated conversations retain the default response.
						const hasToolResult =
							(body.includes("edit_request") || body.includes("powershell_background_request")) &&
							Array.isArray(messages) &&
							messages.some((m: { role?: string }) => m?.role === "tool")

						let responseText = E2E_MOCK_API_RESPONSES.DEFAULT
						let toolCall: typeof E2E_MOCK_EDITOR_TOOL_CALL | typeof E2E_MOCK_POWERSHELL_TOOL_CALL | undefined
						log("Chat completion mock selection:", {
							isEditRequest: body.includes("edit_request"),
							isPowerShellRequest: body.includes("powershell_background_request"),
							hasToolResult,
						})
						if (hasToolResult) {
							responseText = body.includes("powershell_background_request")
								? E2E_MOCK_API_RESPONSES.POWERSHELL_REQUEST_COMPLETE
								: E2E_MOCK_API_RESPONSES.EDIT_REQUEST_COMPLETE
						} else if (body.includes("edit_request")) {
							// Stream lead-in text followed by a structured `editor` tool
							// call (OpenAI tool_calls deltas) — the only tool-call syntax
							// the SDK runtime executes.
							responseText = E2E_MOCK_API_RESPONSES.EDIT_REQUEST_LEAD_IN
							toolCall = E2E_MOCK_EDITOR_TOOL_CALL
						} else if (body.includes("powershell_background_request")) {
							responseText = E2E_MOCK_API_RESPONSES.POWERSHELL_REQUEST_LEAD_IN
							toolCall = E2E_MOCK_POWERSHELL_TOOL_CALL
						}
						const generationId = `gen_${++controller.generationCounter}_${Date.now()}`

						if (stream) {
							res.writeHead(200, {
								"Content-Type": "text/plain",
								"Cache-Control": "no-cache",
								Connection: "keep-alive",
							})

							const randomUUID = uuidv4()

							responseText += `\n\nGenerated UUID: ${randomUUID}`

							const chunks = responseText.split(" ")
							let chunkIndex = 0

							// OpenAI-format streamed tool call deltas, matching what the
							// AI SDK's openai-compatible client expects: the first delta
							// for a tool_calls index must carry `id` + `function.name`;
							// `function.arguments` accumulates as string fragments. Split
							// the arguments JSON to exercise fragment reassembly.
							const argumentsJson = toolCall ? JSON.stringify(toolCall.arguments) : ""
							const argsSplitAt = Math.floor(argumentsJson.length / 2)
							const toolCallDeltas = toolCall
								? [
										[
											{
												index: 0,
												id: toolCall.id,
												type: "function",
												function: { name: toolCall.name, arguments: "" },
											},
										],
										[
											{
												index: 0,
												function: { arguments: argumentsJson.slice(0, argsSplitAt) },
											},
										],
										[
											{
												index: 0,
												function: { arguments: argumentsJson.slice(argsSplitAt) },
											},
										],
									]
								: []
							let toolCallDeltaIndex = 0

							const sendChunk = () => {
								if (chunkIndex < chunks.length) {
									const chunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {
													content: chunks[chunkIndex] + (chunkIndex < chunks.length - 1 ? " " : ""),
												},
												finish_reason: null,
											},
										],
									}
									res.write(`data: ${JSON.stringify(chunk)}\n\n`)
									chunkIndex++
									setTimeout(sendChunk, 10)
								} else if (toolCallDeltaIndex < toolCallDeltas.length) {
									const chunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {
													tool_calls: toolCallDeltas[toolCallDeltaIndex],
												},
												finish_reason: null,
											},
										],
									}
									res.write(`data: ${JSON.stringify(chunk)}\n\n`)
									toolCallDeltaIndex++
									setTimeout(sendChunk, 10)
								} else {
									const finalChunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {},
												finish_reason: toolCall ? "tool_calls" : "stop",
											},
										],
										usage: {
											prompt_tokens: 140,
											completion_tokens: responseText.length,
											total_tokens: 140 + responseText.length,
											cost: (140 + responseText.length) * 0.00015,
										},
									}
									res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
									res.write("data: [DONE]\n\n")
									res.end()
								}
							}

							sendChunk()
							return
						}
						const response = {
							id: generationId,
							object: "chat.completion",
							created: Math.floor(Date.now() / 1000),
							model,
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: "Hello! I'm a mock Cline API response.",
									},
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 140,
								completion_tokens: responseText.length,
								total_tokens: 140 + responseText.length,
								cost: (140 + responseText.length) * 0.00015,
							},
						}
						return sendJson(response)
					}

					// Generation details endpoint
					if (endpoint === "/generation" && method === "GET") {
						return sendJson({ error: "Generation not found" }, 404)
					}
				}

				// Pliny gateway path (/api/llm) — OpenAI-compatible, no Cline account auth.
				// The e2e harness redirects the extension to http://localhost:7777/api/llm via
				// providers.json pre-seeding in the openVSCode fixture, so requests that would
				// normally hit the Pliny gateway (/api/llm) land here.
				if (baseRoute === "/api/llm") {
					if (endpoint === "/models" && method === "GET") {
						// Return a minimal OpenAI-compatible model list so the extension can
						// validate the configured model ID without hitting the real gateway.
						return sendJson({
							object: "list",
							data: [
								{
									id: "snps-aws-bedrock/aws-claude-sonnet-4.6",
									object: "model",
									created: 0,
									owned_by: "pliny",
								},
							],
						})
					}

					if (endpoint === "/chat/completions" && method === "POST") {
						const body = await readBody()
						const parsed = JSON.parse(body)
						const { messages, model = "snps-aws-bedrock/aws-claude-sonnet-4.6", stream = true } = parsed

						let responseText = E2E_MOCK_API_RESPONSES.DEFAULT
						let toolCall: typeof E2E_MOCK_EDITOR_TOOL_CALL | typeof E2E_MOCK_POWERSHELL_TOOL_CALL | null = null

						const hasToolResult =
							(body.includes("edit_request") || body.includes("powershell_background_request")) &&
							Array.isArray(messages) &&
							messages.some((m: { role?: string }) => m?.role === "tool")

						if (hasToolResult) {
							responseText = body.includes("powershell_background_request")
								? E2E_MOCK_API_RESPONSES.POWERSHELL_REQUEST_COMPLETE
								: E2E_MOCK_API_RESPONSES.EDIT_REQUEST_COMPLETE
						} else if (body.includes("edit_request")) {
							responseText = E2E_MOCK_API_RESPONSES.EDIT_REQUEST_LEAD_IN
							toolCall = E2E_MOCK_EDITOR_TOOL_CALL
						} else if (body.includes("powershell_background_request")) {
							responseText = E2E_MOCK_API_RESPONSES.POWERSHELL_REQUEST_LEAD_IN
							toolCall = E2E_MOCK_POWERSHELL_TOOL_CALL
						}

						const generationId = `gen_pliny_${++controller.generationCounter}_${Date.now()}`

						if (stream) {
							res.writeHead(200, {
								"Content-Type": "text/plain",
								"Cache-Control": "no-cache",
								Connection: "keep-alive",
							})

							const chunks = responseText.split(" ")
							let chunkIndex = 0

							const argumentsJson = toolCall ? JSON.stringify(toolCall.arguments) : ""
							const argsSplitAt = Math.floor(argumentsJson.length / 2)
							const toolCallDeltas = toolCall
								? [
										[
											{
												index: 0,
												id: toolCall.id,
												type: "function",
												function: { name: toolCall.name, arguments: "" },
											},
										],
										[
											{
												index: 0,
												function: { arguments: argumentsJson.slice(0, argsSplitAt) },
											},
										],
										[
											{
												index: 0,
												function: { arguments: argumentsJson.slice(argsSplitAt) },
											},
										],
									]
								: []
							let toolCallDeltaIndex = 0

							const sendChunk = () => {
								if (chunkIndex < chunks.length) {
									const chunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {
													content: chunks[chunkIndex] + (chunkIndex < chunks.length - 1 ? " " : ""),
												},
												finish_reason: null,
											},
										],
									}
									res.write(`data: ${JSON.stringify(chunk)}\n\n`)
									chunkIndex++
									setTimeout(sendChunk, 10)
								} else if (toolCallDeltaIndex < toolCallDeltas.length) {
									const chunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {
													tool_calls: toolCallDeltas[toolCallDeltaIndex],
												},
												finish_reason: null,
											},
										],
									}
									res.write(`data: ${JSON.stringify(chunk)}\n\n`)
									toolCallDeltaIndex++
									setTimeout(sendChunk, 10)
								} else {
									const finishReason = toolCall ? "tool_calls" : "stop"
									const finalChunk = {
										id: generationId,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model,
										choices: [
											{
												index: 0,
												delta: {},
												finish_reason: finishReason,
											},
										],
									}
									res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
									res.write("data: [DONE]\n\n")
									res.end()
								}
							}
							sendChunk()
						} else {
							// Non-streaming response
							return sendJson({
								id: generationId,
								object: "chat.completion",
								created: Math.floor(Date.now() / 1000),
								model,
								choices: [
									{
										index: 0,
										message: {
											role: "assistant",
											content: responseText,
										},
										finish_reason: "stop",
									},
								],
							})
						}
						return
					}
				}

				// If we get here, the route was matched but not handled
				return sendJson({ error: "Endpoint not implemented" }, 500)
			}

			handleRequest().catch((err) => {
				console.error("Request handling error:", err)
				if (!res.headersSent) {
					sendApiError("Internal server error", 500)
				} else if (!res.writableEnded) {
					res.end()
				}
			})
		})

		// Initialize the controller after the server is created
		const controller = new ClineApiServerMock(server)
		ClineApiServerMock.globalSharedServer = controller

		// Track connections for proper cleanup
		server.on("connection", (socket) => {
			ClineApiServerMock.globalSockets.add(socket)
			socket.on("close", () => {
				ClineApiServerMock.globalSockets.delete(socket)
			})
		})

		await new Promise<void>((resolve, reject) => {
			server.listen(E2E_API_SERVER_PORT, (error?: Error) => {
				if (error) {
					console.error(`Failed to start server on port ${E2E_API_SERVER_PORT}:`, error)
					reject(error)
				} else {
					log(`ClineApiServerMock listening on port ${E2E_API_SERVER_PORT}`)
					resolve()
				}
			})
		})

		return controller
	}

	// Stops the global shared server
	public static async stopGlobalServer(): Promise<void> {
		if (!ClineApiServerMock.globalSharedServer) {
			return
		}

		const server = ClineApiServerMock.globalSharedServer.server

		// Clean shutdown - destroy all socket connections first
		ClineApiServerMock.globalSockets.forEach((socket) => socket.destroy())
		ClineApiServerMock.globalSockets.clear()

		await new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err) {
					console.error("Error closing server:", err)
					reject(err)
				}
				log("Server closed successfully")
				resolve()
			})
		})

		ClineApiServerMock.globalSharedServer = null
	}
}
