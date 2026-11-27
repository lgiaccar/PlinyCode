import { randomUUID } from "node:crypto";
import { type BrowserWindow, session, WebContentsView } from "electron";
import { type BrowserAction, browserActionSchema } from "./browser-contracts";
import { interactWithPage } from "./browser-page";
import {
	browserUrl,
	type EmbeddedBrowserCommand,
	type EmbeddedBrowserState,
} from "./embedded-browser-contracts";

/** One visible browser shared by tasks; tab 0 never refers to a companion tab. */
export class EmbeddedBrowser {
	private view?: WebContentsView;
	private closed = false;
	private offset = 0;
	private pending?: { task: string; controller: AbortController };
	private bounds?: Extract<EmbeddedBrowserCommand, { operation: "bounds" }>;
	private state: EmbeddedBrowserState = {
		visible: false,
		url: "",
		title: "Browser",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		manual: false,
	};
	constructor(
		private window: BrowserWindow,
		private changed: (state: EmbeddedBrowserState) => void,
	) {
		window.on("resize", () => this.layout());
		window.on("closed", () => this.close());
	}
	status() {
		return { ...this.state };
	}
	private emit() {
		this.changed(this.status());
	}
	private ensure() {
		if (this.closed) throw new Error("Browser is closed.");
		if (this.view) return this.view.webContents;
		// Private, in-memory browsing session. Never uses the Desktop renderer's session.
		const browserSession = session.fromPartition(
			`pliny-browser-${randomUUID()}`,
		);
		browserSession.setPermissionRequestHandler(
			(_contents, _permission, reply) => reply(false),
		);
		browserSession.setPermissionCheckHandler(() => false);
		browserSession.on("will-download", (event) => {
			event.preventDefault();
			this.state.error = "Downloads are not supported in the embedded browser.";
			this.emit();
		});
		this.view = new WebContentsView({
			webPreferences: {
				session: browserSession,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
			},
		});
		this.view.setVisible(false);
		this.window.contentView.addChildView(this.view);
		const contents = this.view.webContents;
		contents.setWindowOpenHandler(() => {
			this.state.error =
				"Pop-up blocked. Open its HTTP or HTTPS URL in the address bar.";
			this.emit();
			return { action: "deny" };
		});
		const guard = (event: Electron.Event, url: string) => {
			try {
				browserUrl(url);
			} catch {
				event.preventDefault();
				this.state.error =
					"Blocked navigation: only HTTP and HTTPS pages are supported.";
				this.emit();
			}
		};
		contents.on("will-navigate", guard);
		contents.on("will-redirect", guard);
		contents.on("will-attach-webview", (event) => event.preventDefault());
		const update = () => {
			if (contents.isDestroyed()) return;
			this.state.url = contents.getURL();
			this.state.title = contents.getTitle().slice(0, 500) || "Browser";
			this.state.loading = contents.isLoading();
			this.state.canGoBack = contents.navigationHistory.canGoBack();
			this.state.canGoForward = contents.navigationHistory.canGoForward();
			this.layout();
			this.emit();
		};
		contents.on("did-start-loading", update);
		contents.on("did-stop-loading", update);
		contents.on("did-navigate", update);
		contents.on("did-navigate-in-page", update);
		contents.on("page-title-updated", update);
		contents.on(
			"did-fail-load",
			(_event, code, description, _url, mainFrame) => {
				if (mainFrame && code !== -3) {
					this.state.error = `Page failed to load: ${description}`;
					update();
				}
			},
		);
		contents.on("render-process-gone", () => {
			this.state.error = "Browser page stopped. Reload to recover.";
			this.state.loading = false;
			this.pending?.controller.abort();
			this.emit();
		});
		return contents;
	}
	private layout() {
		if (!this.view || this.window.isDestroyed()) return;
		const bounds = this.bounds;
		const [width, height] = this.window.getContentSize();
		// Renderer CSS pixels follow page zoom; native child bounds use device-independent pixels.
		const zoom = this.window.webContents.getZoomFactor();
		const x = Math.min(width, Math.round((bounds?.x ?? 0) * zoom));
		const y = Math.min(height, Math.round((bounds?.y ?? 0) * zoom));
		this.view.setBounds({
			x,
			y,
			width: Math.max(
				0,
				Math.min(width - x, Math.round((bounds?.width ?? 0) * zoom)),
			),
			height: Math.max(
				0,
				Math.min(height - y, Math.round((bounds?.height ?? 0) * zoom)),
			),
		});
		this.view.setVisible(
			!!bounds?.visible &&
				this.state.visible &&
				!!this.state.url &&
				bounds.width > 0 &&
				bounds.height > 0,
		);
	}
	async command(command: EmbeddedBrowserCommand) {
		if (command.operation === "status") return this.status();
		if (command.operation === "bounds") {
			this.bounds = command;
			this.layout();
			return this.status();
		}
		if (command.operation === "show") {
			this.state.visible = command.visible;
			if (command.visible) this.ensure();
			this.layout();
			this.emit();
			return this.status();
		}
		if (command.operation === "resume") {
			this.state.manual = false;
			this.emit();
			return this.status();
		}
		const destination =
			command.operation === "navigate" ? browserUrl(command.url) : undefined;
		// Explicit user navigation takes ownership and interrupts outstanding agent actions.
		this.state.manual = true;
		this.pending?.controller.abort();
		this.state.owner = undefined;
		const contents = this.ensure();
		contents.stop();
		this.state.error = undefined;
		if (destination) await contents.loadURL(destination);
		if (command.operation === "back" && contents.navigationHistory.canGoBack())
			contents.navigationHistory.goBack();
		if (
			command.operation === "forward" &&
			contents.navigationHistory.canGoForward()
		)
			contents.navigationHistory.goForward();
		if (command.operation === "reload") contents.reload();
		this.emit();
		return this.status();
	}
	async request(
		task: string,
		input: BrowserAction,
		signal?: AbortSignal,
	): Promise<unknown> {
		const action = browserActionSchema.parse(input);
		signal?.throwIfAborted();
		if (action.operation === "release") {
			this.release(task);
			return "Released embedded browser.";
		}
		if (action.operation === "tabs")
			return [
				{
					id: 0,
					title: this.state.title,
					url: this.state.url,
					browser: "embedded",
				},
			];
		if (action.tabId !== undefined && action.tabId !== 0)
			throw new Error("Unknown embedded tab. Use tabId 0.");
		if (this.state.manual)
			throw new Error(
				"The user has browser control. Ask them to choose Allow agent when finished.",
			);
		if (this.pending || (this.state.owner && this.state.owner !== task))
			throw new Error(
				"The embedded browser is in use by another action or task.",
			);
		if (action.operation === "navigate") browserUrl(action.url ?? "");
		this.state.owner = task;
		this.state.visible = true;
		this.state.error = undefined;
		const contents = this.ensure();
		this.layout();
		this.emit();
		const pending = { task, controller: new AbortController() };
		this.pending = pending;
		const combined = AbortSignal.any([
			pending.controller.signal,
			...(signal ? [signal] : []),
			AbortSignal.timeout(30_000),
		]);
		let abort: () => void = () => {};
		try {
			const interrupted = new Promise<never>((_accept, reject) => {
				abort = () => {
					if (!contents.isDestroyed()) contents.stop();
					reject(
						new Error(
							"Browser action interrupted or timed out. Read the page before retrying; the action may have taken effect.",
						),
					);
				};
				combined.addEventListener("abort", abort, { once: true });
				if (combined.aborted) abort();
			});
			const operation = async () => {
				combined.throwIfAborted();
				const ready = () =>
					new Promise<void>((accept, reject) => {
						const finish = (error?: Error) => {
							contents.removeListener("did-stop-loading", stopped);
							contents.removeListener("destroyed", destroyed);
							combined.removeEventListener("abort", cancelled);
							if (error) reject(error);
							else accept();
						};
						const stopped = () => finish();
						const destroyed = () => finish(new Error("Browser page closed."));
						const cancelled = () =>
							finish(new Error("Browser action interrupted."));
						contents.once("did-stop-loading", stopped);
						contents.once("destroyed", destroyed);
						combined.addEventListener("abort", cancelled, { once: true });
						if (combined.aborted) cancelled();
						else if (!contents.isLoadingMainFrame()) stopped();
					});
				if (action.operation === "navigate") {
					await contents.loadURL(browserUrl(action.url ?? ""));
					await ready();
					combined.throwIfAborted();
					return {
						message: "Page loaded. Read the page before interacting.",
						url: contents.getURL(),
					};
				}
				await ready();
				combined.throwIfAborted();
				browserUrl(contents.getURL());
				if (action.operation === "read" || action.operation === "snapshot")
					this.offset += 500;
				const result = await contents.executeJavaScriptInIsolatedWorld(
					999,
					[
						{
							code: `(${interactWithPage.toString()})(${JSON.stringify(action)}, ${this.offset})`,
						},
					],
					true,
				);
				if (result?.error) throw new Error(result.error);
				return result;
			};
			const running = operation().finally(() => {
				// Cancellation cannot revoke a DOM script already dispatched to Chromium.
				// Keep the action lock until that operation has actually settled.
				if (this.pending === pending) this.pending = undefined;
			});
			return await Promise.race([interrupted, running]);
		} finally {
			combined.removeEventListener("abort", abort);
			this.emit();
		}
	}
	release(task: string) {
		if (this.pending?.task === task) this.pending.controller.abort();
		if (this.state.owner === task) {
			this.state.owner = undefined;
			this.emit();
		}
	}
	close() {
		this.closed = true;
		this.pending?.controller.abort();
		if (this.view && !this.view.webContents.isDestroyed())
			this.view.webContents.close();
		this.view = undefined;
	}
}
