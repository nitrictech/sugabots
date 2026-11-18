import { contextBridge, ipcRenderer } from "electron";
import { type SwitcherBridge, switcherChannels } from "./bridge.ts";

const bridge: SwitcherBridge = {
	accounts: () => ipcRenderer.invoke(switcherChannels.accounts),
	open: (id, slug) => ipcRenderer.invoke(switcherChannels.open, id, slug),
	addAccount: () => ipcRenderer.invoke(switcherChannels.addAccount),
	onAccountsChanged: (listener) => {
		ipcRenderer.on(switcherChannels.accountsChanged, () => listener());
	},
};

contextBridge.exposeInMainWorld("switcher", bridge);
