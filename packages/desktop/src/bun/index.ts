import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import type { SetupRPC } from "../shared/rpc.ts";
import { findServer } from "./server.ts";
import { loadServer, saveServer } from "./settings.ts";

/** For development: opens this server without asking or saving it. */
const serverOverride = process.env.SUGABOTS_URL;

let appWindow: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;

function openServer(origin: string) {
	if (appWindow) {
		appWindow.webview.loadURL(origin);
	} else {
		appWindow = new BrowserWindow({
			title: "Sugabots",
			url: origin,
			frame: { width: 1280, height: 820 },
			// The window shows a remote site and should be sandboxed, but on Linux Electrobun
			// 2.0.2 closes a sandboxed window as soon as it opens. Until then it gets no `rpc`.
			sandbox: false,
		});
		appWindow.on("close", () => {
			appWindow = undefined;
		});
	}
	// Closed after the app window exists, so the app never has no window and quits.
	setupWindow?.close();
}

function openSetup() {
	if (setupWindow) {
		setupWindow.show();
		setupWindow.activate();
		return;
	}
	// The picker is its own window rather than a page in the app window, so the
	// remote site never shares a webview with this RPC.
	setupWindow = new BrowserWindow({
		title: "Sugabots",
		url: "views://setup/index.html",
		frame: { width: 480, height: 560 },
		rpc: BrowserView.defineRPC<SetupRPC>({
			handlers: {
				requests: {
					currentServer: async () => serverOverride ?? (await loadServer()) ?? null,
					connect: async ({ address }) => {
						const found = await findServer(address);
						if (!found.ok) return found;
						await saveServer(found.origin);
						// After the reply is sent, since opening the server closes this window.
						setTimeout(() => openServer(found.origin));
						return { ok: true };
					},
				},
			},
		}),
	});
	setupWindow.on("close", () => {
		setupWindow = undefined;
	});
}

const tray = new Tray({ image: "views://assets/sugabots-logo.svg", template: false });
// Tray leaves its id at 0 when the desktop has no tray (GNOME without the
// AppIndicator extension, or Windows until there is an .ico).
if (tray.id === 0) console.warn("No system tray; Change server is unavailable.");
tray.setMenu([
	{ type: "normal", label: "Change server…", action: "change-server" },
	{ type: "divider" },
	{ type: "normal", label: "Quit Sugabots", action: "quit" },
]);
tray.on("tray-clicked", (event) => {
	const { action } = (event as { data: { action: string } }).data;
	if (action === "change-server") openSetup();
	if (action === "quit") Utils.quit();
});

// Links the app opens in a new tab, such as docs and provider sign-ins, belong in the person's browser.
Electrobun.events.on("new-window-open", (event: { data: { detail: unknown } }) => {
	const { detail } = event.data;
	const url = typeof detail === "string" ? detail : (detail as { url: string }).url;
	Utils.openExternal(url);
});

const server = serverOverride ?? (await loadServer());
if (server) openServer(server);
else openSetup();
