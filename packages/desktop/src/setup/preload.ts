import { contextBridge, ipcRenderer } from "electron";
import { type SetupBridge, setupChannels } from "./bridge.ts";

const bridge: SetupBridge = {
	connect: (address) => ipcRenderer.invoke(setupChannels.connect, address),
};

contextBridge.exposeInMainWorld("setup", bridge);
