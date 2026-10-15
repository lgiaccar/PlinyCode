import * as vscode from "vscode"
import { adoServerTokenPage } from "@/shared/adoServerAuth"
import { Logger } from "@/shared/services/Logger"

const TOKEN_KEY = (host: string) => `plinycode.adoServerToken:${host.toLowerCase()}`
const HOSTS_KEY = "plinycode.adoServerTokenHosts"

/** How long a token check may take before the token is kept unchecked. */
const CHECK_TIMEOUT_MS = 15_000

/**
 * Personal access tokens for on-premises Azure DevOps Servers, one per host.
 *
 * They live in the editor's SecretStorage (the OS keychain) rather than in
 * PlinyCode's file-backed state: they are credentials, and every window must
 * see a token as soon as one window stores it, which SecretStorage's change
 * event gives and the per-window state cache does not.
 */
export class AdoServerTokens implements vscode.Disposable {
	/** Collection URLs seen for each host, so a prompt can link to the right token page and check the token. */
	private readonly servers = new Map<string, string>()
	private readonly changed = new vscode.EventEmitter<void>()
	readonly onDidChange = this.changed.event
	private readonly subscription: vscode.Disposable
	/** Prompts asked or waiting, by host ("" for the one that first asks which server). */
	private readonly pending = new Map<string, Promise<string | undefined>>()
	private queue: Promise<unknown> = Promise.resolve()

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.subscription = secrets.onDidChange((event) => {
			if (event.key === HOSTS_KEY || event.key.startsWith(TOKEN_KEY(""))) this.changed.fire()
		})
	}

	/** Remembers the collection URL of `host`, from a request that needed it. */
	noteServer(host: string, server?: string): void {
		if (server) this.servers.set(host.toLowerCase(), server)
	}

	get(host: string): Thenable<string | undefined> {
		return this.secrets.get(TOKEN_KEY(host))
	}

	/** Hosts with a stored token. */
	async hosts(): Promise<string[]> {
		try {
			const parsed = JSON.parse((await this.secrets.get(HOSTS_KEY)) ?? "[]")
			return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string").sort() : []
		} catch {
			return []
		}
	}

	async set(host: string, token: string): Promise<void> {
		const key = host.toLowerCase()
		await this.secrets.store(TOKEN_KEY(key), token)
		const hosts = await this.hosts()
		if (!hosts.includes(key)) await this.secrets.store(HOSTS_KEY, JSON.stringify([...hosts, key]))
		this.changed.fire()
	}

	async forget(host: string): Promise<void> {
		const key = host.toLowerCase()
		await this.secrets.delete(TOKEN_KEY(key))
		await this.secrets.store(HOSTS_KEY, JSON.stringify((await this.hosts()).filter((h) => h !== key)))
		this.changed.fire()
	}

	/**
	 * Asks for a token for `host` (or first for the host, when none is given),
	 * checks it against the server when its collection is known, and stores it.
	 * Returns the token, or undefined when the user cancelled. One prompt at a
	 * time: a caller for a host already being asked for shares that prompt, and
	 * any other waits its turn.
	 */
	prompt(host?: string): Promise<string | undefined> {
		const key = host?.toLowerCase() ?? ""
		let pending = this.pending.get(key)
		if (!pending) {
			pending = this.queue.then(() => this.ask(host)).finally(() => this.pending.delete(key))
			this.pending.set(key, pending)
			this.queue = pending.catch(() => undefined)
		}
		return pending
	}

	private async ask(requestedHost?: string): Promise<string | undefined> {
		const host = requestedHost?.toLowerCase() ?? (await this.pickHost())
		if (!host) return undefined
		const server = this.servers.get(host)
		// Without the collection the token page's address is unknown; the server's home page links to it.
		const tokenPage = server ? adoServerTokenPage(server) : `https://${host}/`
		let problem: string | undefined
		for (;;) {
			const token = await askForToken(host, tokenPage, problem)
			if (!token) return undefined
			problem = server ? await checkToken(server, token) : undefined
			if (!problem) {
				await this.set(host, token)
				Logger.log(`[DevOpsMcp] Stored a personal access token for Azure DevOps Server ${host}`)
				return token
			}
		}
	}

	private async pickHost(): Promise<string | undefined> {
		const known = [...new Set([...this.servers.keys(), ...(await this.hosts())])].sort()
		if (known.length > 0) {
			const other = "Another server…"
			const choice = await vscode.window.showQuickPick([...known, other], {
				title: "Sign in to Azure DevOps Server",
				placeHolder: "Which server?",
			})
			if (choice !== other) return choice
		}
		const typed = await vscode.window.showInputBox({
			title: "Sign in to Azure DevOps Server",
			prompt: "The server's host name, as in your git remote (e.g. tfs.example.com)",
			ignoreFocusOut: true,
			validateInput: (value) =>
				/^[\w.-]+$/.test(value.trim()) ? undefined : "Enter a host name only, without https:// or a port",
		})
		return typed?.trim().toLowerCase() || undefined
	}

	dispose(): void {
		this.subscription.dispose()
		this.changed.dispose()
	}
}

/** An input box for the token, with a button that opens the server's token page. */
function askForToken(host: string, tokenPage: string, problem?: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const box = vscode.window.createInputBox()
		const openPage: vscode.QuickInputButton = {
			iconPath: new vscode.ThemeIcon("link-external"),
			tooltip: "Create a token on the server",
		}
		box.title = `Azure DevOps Server ${host}`
		box.placeholder = "Personal access token"
		box.prompt = `Paste a personal access token with Code (Read) and Build (Read & execute). Create one under User settings → Personal access tokens at ${tokenPage}`
		box.password = true
		box.ignoreFocusOut = true
		box.buttons = [openPage]
		box.validationMessage = problem
		let settled = false
		const done = (value: string | undefined) => {
			if (settled) return
			settled = true
			resolve(value)
			box.dispose()
		}
		box.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(tokenPage)))
		box.onDidChangeValue(() => {
			box.validationMessage = undefined
		})
		box.onDidAccept(() => {
			const value = box.value.trim()
			if (value) done(value)
		})
		box.onDidHide(() => done(undefined))
		box.show()
	})
}

/**
 * Why the server rejected `token`, or undefined when it accepted it or could not
 * be asked (the network, a proxy): a token that cannot be checked now is kept.
 */
async function checkToken(server: string, token: string): Promise<string | undefined> {
	try {
		const headers = { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, Accept: "application/json" }
		const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS)
		// Redirects are followed by hand: fetch drops the token on a redirect to another host, and a renamed
		// server redirects its old host name to its new one.
		let url = new URL(`${server}/_apis/connectionData`)
		let response = await fetch(url, { headers, signal, redirect: "manual" })
		for (let hops = 0; hops < 5 && response.status >= 300 && response.status < 400; hops++) {
			const location = response.headers.get("location")
			if (!location) break
			url = new URL(location, url)
			if (url.protocol !== "https:") break
			response = await fetch(url, { headers, signal, redirect: "manual" })
		}
		const html = (response.headers.get("content-type") ?? "").includes("text/html")
		if (response.status === 401 || response.status === 403 || (response.ok && html)) {
			return `The server rejected this token (HTTP ${response.status}${html ? ", sign-in page" : ""}). Check it and its scopes.`
		}
		return undefined
	} catch (error) {
		Logger.warn(`[DevOpsMcp] Could not check the token against ${server}: ${error instanceof Error ? error.message : error}`)
		return undefined
	}
}
