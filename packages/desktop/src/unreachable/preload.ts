import { contextBridge, ipcRenderer } from "electron";
import { type UnreachableBridge, unreachableChannels } from "./bridge.ts";

const bridge: UnreachableBridge = {
	retry: () => ipcRenderer.invoke(unreachableChannels.retry),
	switchServer: () => ipcRenderer.invoke(unreachableChannels.switchServer),
};

contextBridge.exposeInMainWorld("unreachable", bridge);
