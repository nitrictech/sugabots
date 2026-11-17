import { join } from "node:path";
import trayIconPath from "@sugabots/avatars/app-icons/icon-64.png?asset";
import {
	app,
	BrowserWindow,
	type HandlerDetails,
	Menu,
	nativeImage,
	shell,
	Tray,
	type WindowOpenHandlerResponse,
} from "electron";
import { findServer } from "./server.ts";
import { loadServer, saveServer } from "./settings.ts";
import { type ConnectResult, setupChannels } from "./setup/bridge.ts";

/** For development: opens this server without asking or saving it. */
const serverOverride = process.env.SUGABOTS_URL;

let appWindow: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;

/** The chosen server's window, or the picker when there is none yet. */
async function openApp() {
	if (appWindow) {
		bringToFront(appWindow);
		return;
	}
	const server = serverOverride ?? (await loadServer());
	if (server) openServer(server);
	else openSetup();
}

function openServer(origin: string) {
	if (!appWindow) {
		appWindow = new BrowserWindow({ title: "Sugabots", width: 1280, height: 820 });
		appWindow.webContents.setWindowOpenHandler(openInBrowser);
		appWindow.on("closed", () => {
			appWindow = undefined;
		});
	}
	void appWindow.loadURL(origin);
	setupWindow?.close();
}

function openSetup() {
	if (setupWindow) {
		bringToFront(setupWindow);
		return;
	}
	// The picker is its own window rather than a page in the app window, so the
	// remote site never shares a renderer with this preload.
	setupWindow = new BrowserWindow({
		title: "Sugabots",
		width: 480,
		height: 560,
		webPreferences: { preload: join(import.meta.dirname, "../preload/setup-preload.cjs") },
	});
	const { ipc } = setupWindow.webContents;
	ipc.handle(setupChannels.currentServer, async () => serverOverride ?? (await loadServer()));
	ipc.handle(setupChannels.connect, async (_event, address: string): Promise<ConnectResult> => {
		const found = await findServer(address);
		if (!found.ok) return found;
		await saveServer(found.origin);
		// After the reply is sent, since opening the server closes this window.
		setImmediate(() => openServer(found.origin));
		return { ok: true };
	});
	setupWindow.on("closed", () => {
		setupWindow = undefined;
	});
	const devServer = process.env.ELECTRON_RENDERER_URL;
	void (devServer
		? setupWindow.loadURL(`${devServer}/page.html`)
		: setupWindow.loadFile(join(import.meta.dirname, "../renderer/page.html")));
}

function bringToFront(window: BrowserWindow) {
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

/** Links the app opens in a new tab, such as docs and provider sign-ins, belong in the person's browser. */
function openInBrowser({ url }: HandlerDetails): WindowOpenHandlerResponse {
	// Other schemes can launch local programs, and the app shows links bots wrote.
	const { protocol } = new URL(url);
	if (protocol === "https:" || protocol === "http:") void shell.openExternal(url);
	return { action: "deny" };
}

function createTray(): Tray {
	const icon = nativeImage.createFromPath(trayIconPath);
	// macOS draws a tray image at its own size instead of fitting it to the menu bar.
	const image = process.platform === "darwin" ? icon.resize({ width: 16, height: 16 }) : icon;
	const tray = new Tray(image);
	tray.setToolTip("Sugabots");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Open Sugabots", click: () => void openApp() },
			{ label: "Change server…", click: openSetup },
			{ type: "separator" },
			{ label: "Quit Sugabots", click: () => app.quit() },
		]),
	);
	return tray;
}

// Before the single-instance lock, which lives in this folder, so a development
// build runs beside an installed copy without sharing its server or settings.
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Sugabots Development"));

if (app.requestSingleInstanceLock()) {
	// Launching the app again reopens its window. That is the way back when the
	// desktop shows no tray, such as GNOME without the AppIndicator extension.
	app.on("second-instance", () => void openApp());
	app.on("activate", () => void openApp());
	// The app stays running when its windows close; the tray's Quit ends it.
	app.on("window-all-closed", () => {});

	// Not awaited: Electron emits `ready` only once this module has finished evaluating.
	void app.whenReady().then(() => {
		const tray = createTray();
		// Referencing it here keeps it alive as long as the app: a collected Tray disappears.
		app.on("quit", () => tray.destroy());
		return openApp();
	});
} else {
	app.quit();
}
