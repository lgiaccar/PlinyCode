import { join } from "node:path";
import {
	getModelsForProvider,
	isPlinyRouterModelId,
	PLINY_FREE_AUTO_MODEL_ID,
} from "@plinycode/llms";
import { getPlinyApiKey, savePlinyApiKey } from "@plinycode/shared/node";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	safeStorage,
	shell,
} from "electron";
import type { BrowserStatus } from "./browser-contracts";
import { actionSchema, active } from "./contracts";
import { taskDiff } from "./git";
import { Integrations } from "./integrations";
import { TaskManager } from "./manager";
import type { PrPreview } from "./pr-contracts";
import { type ImprovedPrompt, PromptImprover } from "./prompt-improver";
import { DesktopStore } from "./store";
import { SecretVault } from "./vault";

const promptImprover = new PromptImprover();

let window: BrowserWindow | undefined,
	manager: TaskManager | undefined,
	integrations: Integrations | undefined,
	exiting = false;
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
		void Promise.allSettled([integrations?.close(), manager.close()]).finally(
			() => app.quit(),
		);
	});
	app.on("window-all-closed", () => app.quit());
	void app
		.whenReady()
		.then(async () => {
			const directory =
				process.env.PLINY_DESKTOP_DATA ??
				join(app.getPath("appData"), "PlinyCode", "desktop");
			const store = new DesktopStore(join(directory, "state.json"));
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
			window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
				let selectedTask: string | undefined, diff: string | undefined;
				let models: string[] | undefined, mcpTools: string[] | undefined;
				let files: string[] | undefined;
				let improvedPrompt: ImprovedPrompt | undefined;
				let browser: BrowserStatus | undefined,
					prPreview: PrPreview | undefined;
				switch (action.type) {
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
					case "addProject": {
						const folder =
							process.env.PLINY_DESKTOP_TEST_PROJECT ??
							(
								await dialog.showOpenDialog(window, {
									properties: ["openDirectory"],
								})
							).filePaths[0];
						if (folder) {
							const project = await manager.addProject(folder);
							selectedTask = manager.createTask(project.id, project.git).id;
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
						if (
							store.state.tasks.some(
								(task) =>
									task.projectId === action.id &&
									(active(task) || manager?.external.has(task.id)),
							)
						)
							throw new Error(
								"Stop project tasks before changing worktree or PR target settings.",
							);
						Object.assign(manager.project(action.id), {
							base: action.base.trim(),
							target: action.target.trim(),
							remote: action.remote,
						});
						manager.changed();
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
						manager.send(action.id, action.prompt, action.cached);
						break;
					case "cancel":
						await manager.cancel(action.id);
						break;
					case "reply":
						manager.reply(action.id, action.inputId, action.value);
						break;
					case "settings":
						store.state.settings = action.settings;
						manager.changed();
						break;
					case "saveKey":
						await savePlinyApiKey(action.key);
						break;
					case "openFolder": {
						const task = manager.task(action.id);
						const error = await shell.openPath(
							task.cwd ?? manager.project(task.projectId).path,
						);
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
					prPreview,
					improvedPrompt,
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
