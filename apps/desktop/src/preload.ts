import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, State } from "./contracts";

const api: DesktopApi = {
	invoke: (action) => ipcRenderer.invoke("plinycode:action", action),
	subscribe: (listener) => {
		const receive = (_event: unknown, state: State) => listener(state);
		ipcRenderer.on("plinycode:state", receive);
		return () => ipcRenderer.removeListener("plinycode:state", receive);
	},
};
contextBridge.exposeInMainWorld("plinycode", api);
