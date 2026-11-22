import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, State } from "./contracts";

const api: DesktopApi = {
	subscribeUpdates: (listener) => {
		const receive = (
			_event: unknown,
			state: import("./desktop-update").UpdateStatus,
		) => listener(state);
		ipcRenderer.on("plinycode:update", receive);
		return () => ipcRenderer.removeListener("plinycode:update", receive);
	},
	invoke: (action) => ipcRenderer.invoke("plinycode:action", action),
	subscribe: (listener) => {
		const receive = (_event: unknown, state: State) => listener(state);
		ipcRenderer.on("plinycode:state", receive);
		return () => ipcRenderer.removeListener("plinycode:state", receive);
	},
};
contextBridge.exposeInMainWorld("plinycode", api);
