/**
 * Credentials, tried in this order:
 *   1. an environment variable (GITHUB_TOKEN / GH_TOKEN, AZURE_DEVOPS_PAT / AZURE_DEVOPS_EXT_PAT);
 *   2. the editor's existing sign-in, through the PlinyCode token broker;
 *   3. a one-time CLI login (`gh auth login`, `az login`);
 *   4. the editor's sign-in prompt (first-time login), through the broker.
 * Nothing is ever stored by this process.
 */
import { exec, execFile } from "node:child_process"
import net from "node:net"
import {
	ADO_RESOURCE_ID,
	BROKER_PATH_ENV,
	BROKER_SECRET_ENV,
	type BrokerRequest,
	type BrokerResponse,
} from "../shared/broker-protocol"
import { DevOpsError } from "./errors"

export interface Auth {
	/** Returns the Authorization header value. */
	header(): Promise<string>
	/** Forgets the cached credential, e.g. after a 401. */
	invalidate(): void
}

interface Credential {
	header: string
	expiresAt: number
}

type Source = () => Promise<Credential | undefined>

const SILENT_BROKER_TIMEOUT_MS = 15_000
const INTERACTIVE_BROKER_TIMEOUT_MS = 5 * 60_000

export function requestBrokerToken(
	provider: BrokerRequest["provider"],
	host: string,
	interactive: boolean,
): Promise<string | undefined> {
	const brokerPath = process.env[BROKER_PATH_ENV]
	const secret = process.env[BROKER_SECRET_ENV]
	if (!brokerPath || !secret) {
		return Promise.resolve(undefined)
	}
	return new Promise((resolve) => {
		let buffer = ""
		const socket = net.createConnection(brokerPath)
		const done = (token?: string) => {
			socket.destroy()
			resolve(token)
		}
		socket.setTimeout(interactive ? INTERACTIVE_BROKER_TIMEOUT_MS : SILENT_BROKER_TIMEOUT_MS, () => done())
		socket.on("error", () => done())
		socket.on("connect", () => {
			const request: BrokerRequest = { secret, provider, host, interactive }
			socket.write(`${JSON.stringify(request)}\n`)
		})
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8")
			const newline = buffer.indexOf("\n")
			if (newline < 0) {
				return
			}
			try {
				const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse
				done("token" in response ? response.token : undefined)
			} catch {
				done()
			}
		})
	})
}

/** Runs a CLI and returns its trimmed stdout, or undefined if it is missing or fails. */
export function runCli(command: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		const done = (error: Error | null, stdout: string) => resolve(error || !stdout.trim() ? undefined : stdout.trim())
		const options = { windowsHide: true, timeout: 60_000 }
		if (process.platform === "win32") {
			// `az` is a .cmd script on Windows, which Node only starts through a shell.
			// The arguments are fixed strings from this module, never user input.
			exec([command, ...args].join(" "), options, done)
		} else {
			execFile(command, args, options, done)
		}
	})
}

class ChainedAuth implements Auth {
	private cached?: Credential

	constructor(
		private readonly sources: Source[],
		private readonly hint: string,
	) {}

	async header(): Promise<string> {
		if (this.cached && Date.now() < this.cached.expiresAt) {
			return this.cached.header
		}
		for (const source of this.sources) {
			const credential = await source()
			if (credential) {
				this.cached = credential
				return credential.header
			}
		}
		throw new DevOpsError(`No credentials available. ${this.hint}`)
	}

	invalidate(): void {
		this.cached = undefined
	}
}

const FOREVER = Number.POSITIVE_INFINITY
// Editor sessions refresh themselves; asking again every few minutes keeps a long-lived server on a fresh token.
const BROKER_REUSE_MS = 10 * 60_000

export function githubAuth(host: string): Auth {
	const bearer = (token: string, expiresAt: number): Credential => ({ header: `Bearer ${token}`, expiresAt })
	const broker = (interactive: boolean) => async () => {
		const token = await requestBrokerToken("github", host, interactive)
		return token ? bearer(token, Date.now() + BROKER_REUSE_MS) : undefined
	}
	return new ChainedAuth(
		[
			async () => {
				const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
				return token ? bearer(token, FOREVER) : undefined
			},
			broker(false),
			async () => {
				const token = await runCli("gh", ["auth", "token", "--hostname", host])
				return token ? bearer(token, FOREVER) : undefined
			},
			broker(true),
		],
		`Sign in to GitHub from the editor when asked, run \`gh auth login --hostname ${host}\` once, or set GITHUB_TOKEN.`,
	)
}

export function adoAuth(): Auth {
	const broker = (interactive: boolean) => async () => {
		const token = await requestBrokerToken("ado", "dev.azure.com", interactive)
		return token ? { header: `Bearer ${token}`, expiresAt: Date.now() + BROKER_REUSE_MS } : undefined
	}
	return new ChainedAuth(
		[
			async () => {
				const pat = process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT
				return pat ? { header: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`, expiresAt: FOREVER } : undefined
			},
			broker(false),
			async () => {
				const out = await runCli("az", ["account", "get-access-token", "--resource", ADO_RESOURCE_ID, "-o", "json"])
				if (!out) {
					return undefined
				}
				try {
					const data = JSON.parse(out) as { accessToken: string; expires_on?: number }
					// Refresh five minutes early so a long request never runs on an expiring token.
					const expiresAt = data.expires_on ? data.expires_on * 1000 - 5 * 60_000 : Date.now() + 25 * 60_000
					return { header: `Bearer ${data.accessToken}`, expiresAt }
				} catch {
					return undefined
				}
			},
			broker(true),
		],
		"Sign in with your Microsoft work account from the editor when asked, run `az login` once, or set AZURE_DEVOPS_PAT.",
	)
}
