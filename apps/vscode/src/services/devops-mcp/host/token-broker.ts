import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import {
	ADO_RESOURCE_ID,
	BROKER_PATH_ENV,
	BROKER_SECRET_ENV,
	type BrokerRequest,
	type BrokerResponse,
} from "../shared/broker-protocol"

/**
 * Hands out the editor's GitHub / Microsoft sign-in tokens to the devops-mcp
 * server process, which cannot call `vscode.authentication` itself.
 *
 * It listens on a per-window named pipe (Windows) or Unix socket, and answers
 * only requests carrying the random secret passed to the server in its
 * environment. Silent requests use existing sessions only; interactive ones may
 * show the editor's sign-in prompt, which is how users log in the first time.
 */
export class TokenBroker implements vscode.Disposable {
	private interactiveQueue: Promise<unknown> = Promise.resolve()

	private constructor(
		private readonly server: net.Server,
		private readonly socketPath: string,
		private readonly secret: string,
	) {}

	static async start(): Promise<TokenBroker> {
		const id = randomBytes(6).toString("hex")
		const socketPath =
			process.platform === "win32"
				? `\\\\.\\pipe\\plinycode-devops-${id}`
				: path.join(os.tmpdir(), `plinycode-devops-${id}.sock`)
		const secret = randomBytes(32).toString("hex")
		const server = net.createServer()
		const broker = new TokenBroker(server, socketPath, secret)
		server.on("connection", (socket) => broker.handle(socket))
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(socketPath, () => {
				server.off("error", reject)
				resolve()
			})
		})
		if (process.platform !== "win32") {
			fs.chmodSync(socketPath, 0o600)
		}
		return broker
	}

	/** Environment the server process needs to reach this broker. */
	get env(): Record<string, string> {
		return { [BROKER_PATH_ENV]: this.socketPath, [BROKER_SECRET_ENV]: this.secret }
	}

	private handle(socket: net.Socket): void {
		let buffer = ""
		socket.setTimeout(10 * 60_000, () => socket.destroy())
		socket.on("error", () => socket.destroy())
		socket.on("data", async (chunk) => {
			buffer += chunk.toString("utf8")
			const newline = buffer.indexOf("\n")
			if (newline < 0) {
				if (buffer.length > 64 * 1024) socket.destroy()
				return
			}
			const reply = (response: BrokerResponse) => socket.end(`${JSON.stringify(response)}\n`)
			let request: BrokerRequest
			try {
				request = JSON.parse(buffer.slice(0, newline))
			} catch {
				reply({ error: "bad request" })
				return
			}
			if (!this.authorized(request.secret)) {
				reply({ error: "unauthorized" })
				return
			}
			try {
				const token = await this.token(request)
				reply(token ? { token } : { error: "no session" })
			} catch (error) {
				reply({ error: error instanceof Error ? error.message : String(error) })
			}
		})
	}

	private authorized(secret: unknown): boolean {
		if (typeof secret !== "string" || secret.length !== this.secret.length) {
			return false
		}
		return timingSafeEqual(Buffer.from(secret), Buffer.from(this.secret))
	}

	private async token(request: BrokerRequest): Promise<string | undefined> {
		const [providerId, scopes] =
			request.provider === "ado"
				? ["microsoft", [`${ADO_RESOURCE_ID}/.default`]]
				: [request.host === "github.com" ? "github" : "github-enterprise", ["repo"]]
		if (!request.interactive) {
			const session = await vscode.authentication.getSession(providerId, scopes, { silent: true })
			return session?.accessToken
		}
		// One sign-in prompt at a time, even when several tool calls need a token at once.
		const next = this.interactiveQueue.then(async () => {
			Logger.log(`[DevOpsMcp] Asking the editor to sign in with ${providerId}`)
			const session = await vscode.authentication.getSession(providerId, scopes, { createIfNone: true })
			return session?.accessToken
		})
		this.interactiveQueue = next.catch(() => undefined)
		return next
	}

	dispose(): void {
		this.server.close()
		if (process.platform !== "win32") {
			fs.rmSync(this.socketPath, { force: true })
		}
	}
}
