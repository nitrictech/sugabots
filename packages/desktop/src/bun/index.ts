import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import type { ApprovalRPC, CommandRequest, SetupRPC } from "../shared/rpc.ts";
import { connectDevice } from "./device.ts";
import { findServer } from "./server.ts";
import { loadServer, saveServer } from "./settings.ts";

/** For development: opens this server without asking or saving it. */
const serverOverride = process.env.SUGABOTS_URL;

let appWindow: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let device: { origin: string; disconnect: () => void } | undefined;

/** The chosen server's window, or the picker when there is none yet. */
async function openApp() {
	if (appWindow) {
		appWindow.show();
		appWindow.activate();
		return;
	}
	const server = serverOverride ?? (await loadServer());
	if (server) openServer(server);
	else openSetup();
}

function openServer(origin: string) {
	connectTo(origin);
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
			quitWithoutTray();
		});
	}
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
		quitWithoutTray();
	});
}

/** Offers this computer's tools to the server at `origin`, and to no other. */
function connectTo(origin: string) {
	if (device?.origin === origin) return;
	device?.disconnect();
	device = { origin, ...connectDevice({ origin, approve: askToRun }) };
}

/** Asks the owner, in a window over the app's, whether a bot may run `request` here. */
function askToRun(request: CommandRequest): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const answer = (allow: boolean) => {
			if (answered) return;
			answered = true;
			resolve(allow);
		};
		const approval: BrowserWindow = new BrowserWindow({
			title: "Allow this command?",
			url: "views://approve/index.html",
			frame: centredOver(appWindow, APPROVAL_SIZE),
			// A fixed-size window, as dialogs are, which window managers that tile also float.
			styleMask: { Resizable: false, Miniaturizable: false },
			rpc: BrowserView.defineRPC<ApprovalRPC>({
				handlers: {
					requests: {
						command: () => request,
						decide: ({ allow }) => {
							answer(allow);
							// After the reply is sent, since this closes the window it came from.
							setTimeout(() => approval.close());
						},
					},
				},
			}),
		});
		approval.setAlwaysOnTop(true);
		// Closing the window without answering is a no.
		approval.on("close", () => answer(false));
	});
}

const APPROVAL_SIZE = { width: 520, height: 340 };

/** A frame of `size` centred over `parent`, or with no position for the window manager to choose. */
function centredOver(
	parent: BrowserWindow | undefined,
	size: { width: number; height: number },
): { x?: number; y?: number; width: number; height: number } {
	if (!parent?.isVisible()) return size;
	const frame = parent.getFrame();
	return {
		...size,
		x: Math.round(frame.x + (frame.width - size.width) / 2),
		y: Math.round(frame.y + (frame.height - size.height) / 2),
	};
}

/** Without a tray there would be no way back to a closed app, so closing its last window quits it. */
function quitWithoutTray() {
	if (tray.id === 0 && !appWindow && !setupWindow) Utils.quit();
}

const tray = new Tray({ image: "views://assets/sugabots-logo.svg", template: false });
// Tray leaves its id at 0 when the desktop has no tray (GNOME without the
// AppIndicator extension, or Windows until there is an .ico).
if (tray.id === 0) console.warn("No system tray; closing the window quits Sugabots.");
tray.setMenu([
	{ type: "normal", label: "Open Sugabots", action: "open" },
	{ type: "normal", label: "Change server…", action: "change-server" },
	{ type: "divider" },
	{ type: "normal", label: "Quit Sugabots", action: "quit" },
]);
tray.on("tray-clicked", (event) => {
	const { action } = (event as { data: { action: string } }).data;
	if (action === "open") openApp();
	if (action === "change-server") openSetup();
	if (action === "quit") Utils.quit();
});

// Links the app opens in a new tab, such as docs and provider sign-ins, belong in the person's browser.
Electrobun.events.on("new-window-open", (event: { data: { detail: unknown } }) => {
	const { detail } = event.data;
	const url = typeof detail === "string" ? detail : (detail as { url: string }).url;
	Utils.openExternal(url);
});

await openApp();
