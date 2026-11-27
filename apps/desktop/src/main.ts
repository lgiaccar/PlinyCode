import { join } from "node:path";
import {
	createHandlerAsync,
	getModelsForProvider,
	isPlinyRouterModelId,
	PLINY_FREE_AUTO_MODEL_ID,
} from "@plinycode/llms";
import { getPlinyApiKey, savePlinyApiKey } from "@plinycode/shared/node";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	net,
	safeStorage,
	shell,
} from "electron";
import type { BrowserStatus } from "./browser-contracts";
import { actionSchema, active } from "./contracts";
import type { DesktopUpdate } from "./desktop-update";
import { DraftStore } from "./draft-store";
import { EmbeddedBrowser } from "./embedded-browser";
import type { EmbeddedBrowserState } from "./embedded-browser-contracts";
import { taskDiff } from "./git";
import { Integrations } from "./integrations";
import { webLink } from "./links";
import { TaskManager } from "./manager";
import { DesktopNextPrompt } from "./next-prompt";
import type { PrPreview } from "./pr-contracts";
import { supportsWorktree, taskFolders } from "./project-folders";
import { type ImprovedPrompt, PromptImprover } from "./prompt-improver";
import { DesktopStore } from "./store";
import { createDesktopUpdate } from "./update-runtime";
import { SecretVault } from "./vault";

// Electron's network stack honors OS certificate trust and proxy settings.
// Node fetch can otherwise retry a TLS failure until the rewrite deadline expires.
const promptImprover = new PromptImprover((config) =>
	createHandlerAsync({ ...config, fetch: net.fetch.bind(net) as typeof fetch }),
);
const nextPrompt = new DesktopNextPrompt((config) =>
	createHandlerAsync({ ...config, fetch: net.fetch.bind(net) as typeof fetch }),
);
let updater: DesktopUpdate | undefined;

let window: BrowserWindow | undefined,
	manager: TaskManager | undefined,
	integrations: Integrations | undefined,
	exiting = false;
let flushDrafts = async () => {};
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", () => {
		window?.restore();
		window?.focus();
	});
	app.on("before-quit", (event) => {
		if (exiting || !manager) return;
		event.preventDefault();
		exiting = true;
		promptImprover.close();
		nextPrompt.close();
		updater?.close();
		void flushDrafts()
			.then(() => Promise.allSettled([integrations?.close(), manager!.close()]))
			.finally(() => app.quit());
	});
	app.on("window-all-closed", () => app.quit());
	void app
		.whenReady()
		.then(async () => {
			const directory =
				process.env.PLINY_DESKTOP_DATA ??
				join(app.getPath("appData"), "PlinyCode", "desktop");
			const store = new DesktopStore(join(directory, "state.json"));
			const drafts = new DraftStore(join(directory, "drafts.json"));
			const vault = new SecretVault(
				join(directory, "mcp-secrets.json"),
				safeStorage,
			);
			const servers = () =>
				(store.state.mcpServers ?? [])
					.filter((server) => server.enabled)
					.map((server) => ({
						...server,
						secrets: vault.read(server.id),
					}));
			const distribution = join(app.getAppPath(), "dist");
			const resources = app.isPackaged ? process.resourcesPath : distribution;
			const runtime = join(
				resources,
				"runtime",
				process.platform === "win32" ? "bun.exe" : "bun",
			);
			manager = new TaskManager(
				store,
				directory,
				runtime,
				join(resources, "worker.js"),
				() => {
					if (window && !window.isDestroyed())
						window.webContents.send("plinycode:state", store.state);
				},
				getPlinyApiKey,
				servers,
			);
			await manager.migrateProjects();
			integrations = new Integrations(manager, vault);
			window = new BrowserWindow({
				title: "PlinyCode Desktop",
				width: 1240,
				height: 850,
				minWidth: 900,
				minHeight: 600,
				backgroundColor: "#151819",
				autoHideMenuBar: true,
				webPreferences: {
					preload: join(distribution, "preload.cjs"),
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
				},
			});
			flushDrafts = () =>
				new Promise<void>((resolve) => {
					if (
						!window ||
						window.isDestroyed() ||
						window.webContents.isDestroyed()
					) {
						resolve();
						return;
					}
					const finish = () => {
						clearTimeout(timeout);
						ipcMain.removeListener("plinycode:draftsFlushed", received);
						resolve();
					};
					const received = (event: Electron.IpcMainEvent) => {
						if (
							event.sender === window?.webContents &&
							event.senderFrame === window.webContents.mainFrame
						)
							finish();
					};
					const timeout = setTimeout(finish, 3000);
					ipcMain.on("plinycode:draftsFlushed", received);
					window.webContents.send("plinycode:flushDrafts");
				});
			window.on("close", (event) => {
				if (!exiting) {
					event.preventDefault();
					app.quit();
				}
			});
			window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			integrations.embeddedBrowser = new EmbeddedBrowser(window, (state) => {
				if (window && !window.isDestroyed())
					window.webContents.send("plinycode:browser", state);
			});
			window.webContents.on("context-menu", (_event, params) => {
				Menu.buildFromTemplate([
					{ role: "copy", enabled: !!params.selectionText },
					...(params.isEditable
						? [
								{ role: "cut" as const, enabled: !!params.selectionText },
								{ role: "paste" as const },
								{ role: "selectAll" as const },
							]
						: []),
				]).popup({ window });
			});
			updater = createDesktopUpdate(
				(update) => {
					if (!window?.isDestroyed())
						window?.webContents.send("plinycode:update", update);
				},
				() =>
					!!manager?.external.size ||
					store.state.tasks.some(active) ||
					(store.state.commands ?? []).some(
						(command) => command.status === "running",
					),
				async () => {
					promptImprover.close();
				},
			);
			updater.configure(
				store.state.settings.autoCheckUpdates &&
					!process.env.PLINY_DESKTOP_TEST_PROJECT,
			);
			window.webContents.on("will-navigate", (event) => event.preventDefault());
			window.webContents.session.setPermissionRequestHandler(
				(_contents, _permission, reply) => reply(false),
			);
			ipcMain.handle("plinycode:action", async (event, raw) => {
				if (
					!manager ||
					!integrations ||
					event.sender !== window?.webContents ||
					event.senderFrame !== window.webContents.mainFrame
				)
					throw new Error("Untrusted desktop sender.");
				const action = actionSchema.parse(raw);
				if (
					updater?.status.phase === "installing" &&
					!["snapshot", "updateStatus"].includes(action.type)
				)
					throw new Error("Desktop is installing an update.");
				let selectedTask: string | undefined, diff: string | undefined;
				let models: string[] | undefined, mcpTools: string[] | undefined;
				let files: string[] | undefined;
				let embeddedBrowser: EmbeddedBrowserState | undefined;
				let improvedPrompt: ImprovedPrompt | undefined;
				let suggestedPrompt: string | undefined;
				let browser: BrowserStatus | undefined,
					prPreview: PrPreview | undefined;
				switch (action.type) {
					case "embeddedBrowser":
						embeddedBrowser = await integrations.embeddedBrowser?.command(
							action.command,
						);
						break;
					case "openLink": {
						const url = webLink(action.url);
						if (!url)
							throw new Error("Only HTTP and HTTPS links can be opened.");
						await shell.openExternal(url);
						break;
					}
					case "loadDrafts":
						return { state: store.state, drafts: drafts.drafts };
					case "saveDraft":
						manager.task(action.id);
						drafts.save(action.id, {
							text: action.text,
							revision: action.revision,
						});
						return;
					case "removePending":
						manager.removePending(action.id, action.messageId);
						break;
					case "copyMessage": {
						const entry = manager
							.task(action.id)
							.messages.find((item) => item.id === action.messageId);
						if (!entry) throw new Error("Message not found.");
						clipboard.writeText(entry.text);
						break;
					}
					case "restartFrom":
						await manager.restartFrom(
							action.id,
							action.messageId,
							action.prompt,
						);
						break;
					case "updateStatus":
						break;
					case "updateCheck":
						await updater?.check();
						break;
					case "updateDownload":
						await updater?.download();
						break;
					case "updateInstall":
						await updater?.install();
						break;
					case "suggestNextPrompt":
						suggestedPrompt = await nextPrompt.suggest(
							manager.task(action.id),
							action.messageId,
							await getPlinyApiKey().catch(() => ""),
						);
						break;
					case "improvePrompt":
						improvedPrompt = await promptImprover.improve(
							action.prompt,
							await getPlinyApiKey().catch(() => ""),
						);
						break;
					case "browserPair":
						browser = await integrations.pair(action.extensionId);
						break;
					case "browserStatus":
						browser = integrations.browser?.status() ?? { connected: false };
						break;
					case "browserDisconnect":
						await integrations.disconnectBrowser();
						browser = { connected: false };
						break;
					case "browserExtensionFolder": {
						const error = await shell.openPath(
							join(resources, "browser-extension"),
						);
						if (error) throw new Error(error);
						break;
					}
					case "savePrRepository": {
						const project = manager.project(action.id);
						if (
							store.state.tasks.some(
								(task) =>
									task.projectId === project.id &&
									(active(task) || manager?.external.has(task.id)),
							)
						)
							throw new Error(
								"Stop project tasks before changing PR credentials or settings.",
							);
						if (action.token)
							vault.write(`pr:${project.id}`, {
								env: { TOKEN: action.token },
								headers: {},
							});
						else if (
							JSON.stringify(project.prRepository) !==
							JSON.stringify(action.repository)
						)
							vault.write(`pr:${project.id}`);
						project.prRepository = action.repository;
						project.hasPrToken = !!vault.read(`pr:${project.id}`).env.TOKEN;
						manager.changed();
						break;
					}
					case "prPreview":
						prPreview = await integrations.preview(manager.task(action.id));
						break;
					case "prRefresh":
						await integrations.refresh(manager.task(action.id));
						break;
					case "prCreate":
						await integrations.create(manager.task(action.id), action.input);
						break;
					case "prOpen": {
						const url = manager.task(action.id).pullRequest?.url;
						if (!url || !/^https?:\/\//.test(url))
							throw new Error("No PR link is available.");
						await shell.openExternal(url);
						break;
					}
					case "attachFiles":
						files = (
							await dialog.showOpenDialog(window, {
								properties: ["openFile", "multiSelections"],
							})
						).filePaths;
						break;
					case "stopCommand":
						await manager.commands.stop(action.id, action.commandId);
						break;
					case "models":
						models = Object.keys(
							await getModelsForProvider("pliny", { filter: "chat" }),
						)
							.filter(
								(id) =>
									!isPlinyRouterModelId(id) || id === PLINY_FREE_AUTO_MODEL_ID,
							)
							.sort();
						break;
					case "saveMcp": {
						const list = store.state.mcpServers ?? [];
						if (
							list.some(
								(server) =>
									server.name === action.server.name &&
									server.id !== action.server.id,
							)
						)
							throw new Error("MCP server names must be unique.");
						if (action.secrets) vault.write(action.server.id, action.secrets);
						const secrets = vault.read(action.server.id);
						const saved = {
							...action.server,
							hasSecrets:
								Object.keys(secrets.env).length +
									Object.keys(secrets.headers).length >
								0,
						};
						store.state.mcpServers = [
							...list.filter((server) => server.id !== saved.id),
							saved,
						];
						manager.changed();
						break;
					}
					case "removeMcp":
						vault.write(action.id);
						store.state.mcpServers = (store.state.mcpServers ?? []).filter(
							(server) => server.id !== action.id,
						);
						manager.changed();
						break;
					case "testMcp": {
						const server = store.state.mcpServers?.find(
							(item) => item.id === action.id,
						);
						if (!server) throw new Error("MCP server not found.");
						mcpTools = await manager.testMcp({
							...server,
							secrets: vault.read(server.id),
						});
						break;
					}
					case "snapshot":
						break;
					case "pickProjectFolders":
					case "addProject": {
						const folders =
							action.type === "addProject" &&
							process.env.PLINY_DESKTOP_TEST_PROJECT
								? [process.env.PLINY_DESKTOP_TEST_PROJECT]
								: (
										await dialog.showOpenDialog(window, {
											properties: ["openDirectory", "multiSelections"],
										})
									).filePaths;
						if (action.type === "pickProjectFolders") files = folders;
						else if (folders.length) {
							const project = await manager.addProject(folders);
							selectedTask = manager.createTask(
								project.id,
								supportsWorktree(project),
							).id;
						}
						break;
					}
					case "createTask":
						selectedTask = manager.createTask(
							action.projectId,
							action.worktree,
						).id;
						break;
					case "projectSettings":
						await manager.updateProject(action.id, {
							name: action.name,
							folders: action.folders,
							worktreeSource: action.worktreeSource,
							base: action.base,
							target: action.target,
							remote: action.remote,
						});
						break;
					case "configureTask": {
						const task = manager.task(action.id);
						if (active(task))
							throw new Error(
								"Stop this task before changing its model or permissions.",
							);
						Object.assign(task, {
							model: action.model,
							permissions: action.permissions,
						});
						manager.changed();
						break;
					}
					case "send":
						manager.send(
							action.id,
							action.prompt,
							action.cached,
							action.delivery,
						);
						break;
					case "cancel":
						await manager.cancel(action.id);
						break;
					case "reply":
						manager.reply(action.id, action.inputId, action.value);
						break;
					case "settings":
						store.state.settings = action.settings;
						updater?.configure(
							action.settings.autoCheckUpdates &&
								!process.env.PLINY_DESKTOP_TEST_PROJECT,
						);
						manager.changed();
						break;
					case "saveKey":
						await savePlinyApiKey(action.key);
						break;
					case "openFolder": {
						const task = manager.task(action.id);
						const folders = taskFolders(task, manager.project(task.projectId));
						const folder = action.folder ?? folders[0];
						if (!folders.includes(folder))
							throw new Error("Folder does not belong to this chat.");
						const error = await shell.openPath(folder);
						if (error) throw new Error(error);
						break;
					}
					case "diff":
						diff = await taskDiff(manager.task(action.id));
						break;
				}
				return {
					state: store.state,
					selectedTask,
					diff,
					models,
					mcpTools,
					files,
					browser,
					embeddedBrowser,
					prPreview,
					improvedPrompt,
					suggestedPrompt,
					update: updater?.status,
					...(action.type === "snapshot" || action.type === "saveKey"
						? {
								credentialAvailable: !!(await getPlinyApiKey().catch(() => "")),
							}
						: {}),
				};
			});
			await window.loadFile(join(distribution, "index.html"));
		})
		.catch((error) => {
			dialog.showErrorBox("PlinyCode could not start", String(error));
			app.quit();
		});
}
