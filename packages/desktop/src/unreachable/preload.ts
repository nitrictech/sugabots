import { contextBridge, ipcRenderer } from "electron";
import { type UnreachableBridge, unreachableChannels } from "./bridge.ts";

const bridge: UnreachableBridge = {
	retry: () => ipcRenderer.invoke(unreachableChannels.retry),
	switchWorkspace: () => ipcRenderer.invoke(unreachableChannels.switchWorkspace),
};

contextBridge.exposeInMainWorld("unreachable", bridge);
