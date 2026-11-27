import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, State } from "./contracts";

const draftWrites = new Set<Promise<unknown>>();
ipcRenderer.on("plinycode:flushDrafts", () => {
	void Promise.allSettled([...draftWrites]).then(() =>
		ipcRenderer.send("plinycode:draftsFlushed"),
	);
});
const api: DesktopApi = {
	subscribeBrowser: (listener) => {
		const receive = (
			_event: unknown,
			state: import("./embedded-browser-contracts").EmbeddedBrowserState,
		) => listener(state);
		ipcRenderer.on("plinycode:browser", receive);
		return () => ipcRenderer.removeListener("plinycode:browser", receive);
	},
	subscribeUpdates: (listener) => {
		const receive = (
			_event: unknown,
			state: import("./desktop-update").UpdateStatus,
		) => listener(state);
		ipcRenderer.on("plinycode:update", receive);
		return () => ipcRenderer.removeListener("plinycode:update", receive);
	},
	invoke: (action) => ipcRenderer.invoke("plinycode:action", action),
	saveDraft: (id, draft) => {
		const result = ipcRenderer.invoke("plinycode:action", {
			type: "saveDraft",
			id,
			...draft,
		});
		draftWrites.add(result);
		void result.then(
			() => draftWrites.delete(result),
			() => draftWrites.delete(result),
		);
		return result;
	},
	subscribe: (listener) => {
		const receive = (_event: unknown, state: State) => listener(state);
		ipcRenderer.on("plinycode:state", receive);
		return () => ipcRenderer.removeListener("plinycode:state", receive);
	},
};
contextBridge.exposeInMainWorld("plinycode", api);
