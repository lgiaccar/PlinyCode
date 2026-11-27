import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { type BrowserAction, browserActionSchema } from "./browser-contracts";

/** A private, ephemeral loopback channel, not an application API server. */
export class BrowserBridge {
	private server = createServer((_request, response) => {
		response.writeHead(404);
		response.end();
	});
	private sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 512_000,
	});
	private peer?: WebSocket;
	private token = randomBytes(32).toString("hex");
	private address?: string;
	private leases = new Map<number, string>();
	private pending = new Map<
		string,
		{ task: string; finish: (error?: Error, value?: unknown) => void }
	>();
	constructor(
		extensionId: string,
		private timeout = 30_000,
	) {
		if (!/^[a-p]{32}$/.test(extensionId))
			throw new Error("Enter the Chrome or Edge extension ID (32 letters).");
		this.server.on("upgrade", (request, socket, head) => {
			if (
				request.headers.origin !== `chrome-extension://${extensionId}` ||
				request.url !== "/bridge"
			) {
				socket.destroy();
				return;
			}
			this.sockets.handleUpgrade(request, socket, head, (peer) =>
				this.connect(peer),
			);
		});
	}
	async start() {
		await new Promise<void>((accept, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", accept);
		});
		const address = this.server.address();
		if (!address || typeof address === "string")
			throw new Error("Browser bridge failed to start.");
		this.address = `ws://127.0.0.1:${address.port}/bridge`;
		return this.status(true);
	}
	status(pair = false) {
		return {
			connected: this.peer?.readyState === WebSocket.OPEN,
			...(pair ? { address: this.address, token: this.token } : {}),
		};
	}
	private connect(peer: WebSocket) {
		let authenticated = false;
		const deadline = setTimeout(() => peer.terminate(), 5000);
		peer.on("error", () => {});
		peer.on("message", (raw) => {
			try {
				const message = JSON.parse(raw.toString());
				if (!authenticated) {
					const token = Buffer.from(
						typeof message.token === "string" ? message.token : "",
					);
					if (
						message.type !== "hello" ||
						token.length !== this.token.length ||
						!timingSafeEqual(token, Buffer.from(this.token)) ||
						this.peer
					) {
						peer.close(1008);
						return;
					}
					authenticated = true;
					clearTimeout(deadline);
					this.peer = peer;
					peer.send(JSON.stringify({ type: "ready" }));
					return;
				}
				if (message.type === "ping") {
					peer.send('{"type":"pong"}');
					return;
				}
				if (message.type === "result" && typeof message.id === "string")
					this.pending
						.get(message.id)
						?.finish(
							message.error
								? new Error(String(message.error).slice(0, 2000))
								: undefined,
							message.value,
						);
			} catch {
				peer.close(1008);
			}
		});
		peer.on("close", () => {
			clearTimeout(deadline);
			if (this.peer !== peer) return;
			this.peer = undefined;
			for (const item of [...this.pending.values()])
				item.finish(
					new Error(
						"Browser disconnected. Inspect the tab before retrying an action.",
					),
				);
			this.leases.clear();
		});
	}
	async request(
		task: string,
		input: BrowserAction,
		signal?: AbortSignal,
	): Promise<unknown> {
		const action = browserActionSchema.parse(input);
		if (action.operation === "read") action.operation = "snapshot";
		signal?.throwIfAborted();
		if (action.operation === "release") {
			this.release(task);
			return "Released this task's tabs.";
		}
		if (!this.peer || this.peer.readyState !== WebSocket.OPEN)
			throw new Error(
				"Connect the PlinyCode browser companion in Settings and share a tab first.",
			);
		if (action.operation !== "tabs") {
			if (action.tabId === undefined) throw new Error("tabId is required.");
			const owner = this.leases.get(action.tabId);
			if (owner && owner !== task)
				throw new Error("This tab is in use by another task.");
			this.leases.set(action.tabId, task);
		}
		const id = randomUUID();
		return new Promise((accept, reject) => {
			const finish = (error?: Error, value?: unknown) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				this.pending.delete(id);
				if (error) reject(error);
				else accept(value);
			};
			const abort = () =>
				finish(
					new Error(
						"Browser action interrupted; inspect the tab before retrying.",
					),
				);
			const timer = setTimeout(
				() =>
					finish(
						new Error(
							"Browser action timed out; inspect the tab before retrying.",
						),
					),
				this.timeout,
			);
			this.pending.set(id, { task, finish });
			signal?.addEventListener("abort", abort, { once: true });
			this.peer?.send(
				JSON.stringify({ type: "action", id, action }),
				(error) => {
					if (error) finish(error);
				},
			);
		});
	}
	release(task: string) {
		for (const pending of [...this.pending.values()])
			if (pending.task === task) pending.finish(new Error("Task stopped."));
		for (const [tab, owner] of this.leases)
			if (owner === task) this.leases.delete(tab);
	}
	async close() {
		for (const pending of [...this.pending.values()])
			pending.finish(new Error("Browser bridge stopped."));
		for (const peer of this.sockets.clients) peer.terminate();
		this.peer = undefined;
		this.leases.clear();
		this.sockets.close();
		await new Promise<void>((accept) => this.server.close(() => accept()));
	}
}
