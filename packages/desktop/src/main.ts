import { join } from "node:path";
import trayIconPath from "@sugabots/avatars/app-icons/icon-64.png?asset";
import {
	app,
	BrowserWindow,
	dialog,
	Menu,
	type MenuItemConstructorOptions,
	nativeImage,
	Tray,
} from "electron";
import {
	AppWindow,
	type AppWindowEvents,
	bringToFront,
	type ServerToShow,
	savedServerSession,
} from "./app-window.ts";
import { loadLocalPage, localPreload } from "./local-page.ts";
import {
	loadSavedServers,
	type SavedServer,
	type SavedServers,
	ServerId,
	saveSavedServers,
	serverById,
	serverHost,
	serverLabel,
	withAccount,
	withServerAdded,
	withServerOpened,
	withServerRemoved,
} from "./saved-servers.ts";
import { findServer } from "./server.ts";
import { type ConnectResult, setupChannels } from "./setup/bridge.ts";

/** For development: opens this server, in a session of its own, without asking or saving it. */
const serverOverride: ServerToShow | undefined = process.env.SUGABOTS_URL
	? { id: ServerId.make("sugabots-url"), origin: process.env.SUGABOTS_URL }
	: undefined;

/** How many servers get a CmdOrCtrl+number shortcut. */
const SERVER_SHORTCUT_COUNT = 9;

let saved: SavedServers = { servers: [] };
let appWindow: AppWindow | undefined;
let setupWindow: BrowserWindow | undefined;
// Held for the app's lifetime, since a garbage-collected Tray disappears.
let tray: Tray | undefined;

/** The app window, or the picker when no server has been added yet. */
function openApp() {
	if (appWindow) {
		appWindow.bringToFront();
		return;
	}
	const server = serverOverride ?? serverById(saved, saved.current);
	if (server) showServer(server);
	else openSetup();
}

/** Saves `origin` again, with a session of its own for signing in to another account, and opens it. */
async function addServer(origin: string) {
	saved = withServerAdded(saved, origin);
	showCurrentServer();
	await saveSavedServers(saved);
}

/** Opens the saved server `id` and remembers it as the one the app opens. */
async function openServer(id: ServerId) {
	saved = withServerOpened(saved, id);
	showCurrentServer();
	await saveSavedServers(saved);
}

function showCurrentServer() {
	const server = serverById(saved, saved.current);
	if (server) showServer(server);
}

function showServer(server: ServerToShow) {
	if (appWindow) appWindow.show(server);
	else appWindow = new AppWindow(server, appWindowEvents);
	appWindow.bringToFront();
	setupWindow?.close();
	serversChanged();
}

const appWindowEvents: AppWindowEvents = {
	title: (pageTitle, id) => {
		const server = serverById(saved, id);
		return server && saved.servers.length > 1
			? `${pageTitle} — ${serverLabel(saved, server)}`
			: pageTitle;
	},
	account: (id, account) => {
		const updated = withAccount(saved, id, account);
		if (updated === saved) return;
		saved = updated;
		serversChanged();
		void saveSavedServers(saved);
	},
	switchServer: () => {
		Menu.buildFromTemplate(serverMenuItems()).popup({ window: appWindow?.window });
	},
	closed: () => {
		appWindow = undefined;
		serversChanged();
	},
};

async function removeServer(server: SavedServer) {
	const { response } = await dialog.showMessageBox({
		type: "warning",
		message: `Remove ${serverLabel(saved, server)}?`,
		detail: "This signs you out of it on this computer. You can add it again later.",
		buttons: ["Remove", "Cancel"],
		defaultId: 1,
		cancelId: 1,
	});
	if (response !== 0) return;
	saved = withServerRemoved(saved, server.id);
	if (appWindow?.serverId === server.id) {
		const next = serverById(saved, saved.current);
		if (next) showServer(next);
		else {
			appWindow.window.close();
			openSetup();
		}
	}
	serversChanged();
	await saveSavedServers(saved);
	// After its page has closed, so the page can't write its sign-in back.
	const session = savedServerSession(server.id);
	await Promise.all([session.clearStorageData(), session.clearCache()]);
}

function openSetup() {
	if (setupWindow) {
		bringToFront(setupWindow);
		return;
	}
	// The picker is its own window rather than a page in the app window, so a
	// server's page never shares a renderer with this preload.
	setupWindow = new BrowserWindow({
		title: "Sugabots",
		width: 480,
		height: 560,
		webPreferences: { preload: localPreload("setup") },
	});
	setupWindow.removeMenu();
	setupWindow.webContents.ipc.handle(
		setupChannels.connect,
		async (_event, address: string): Promise<ConnectResult> => {
			const found = await findServer(address);
			if (!found.ok) return found;
			// After the reply is sent, since opening the server closes this window.
			setImmediate(() => void addServer(found.origin));
			return { ok: true };
		},
	);
	setupWindow.on("closed", () => {
		setupWindow = undefined;
	});
	void loadLocalPage(setupWindow.webContents, "setup");
}

/** Menus list the saved servers, so they're rebuilt whenever the list or the open server changes. */
function serversChanged() {
	Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu()));
	tray?.setContextMenu(Menu.buildFromTemplate(trayMenu()));
	appWindow?.refreshTitle();
}

function serverMenuItems(): MenuItemConstructorOptions[] {
	const shown = serverById(saved, appWindow?.serverId ?? saved.current);
	const servers = saved.servers.map(
		(server, index): MenuItemConstructorOptions => ({
			label: serverLabel(saved, server),
			type: "radio",
			checked: server === shown,
			accelerator: index < SERVER_SHORTCUT_COUNT ? `CommandOrControl+${index + 1}` : undefined,
			click: () => void openServer(server.id),
		}),
	);
	const shownItems: MenuItemConstructorOptions[] = shown
		? [
				{
					label: `Add another account on ${serverHost(shown.origin)}…`,
					click: () => void addServer(shown.origin),
				},
				{ label: `Remove ${serverLabel(saved, shown)}…`, click: () => void removeServer(shown) },
			]
		: [];
	return [
		...servers,
		...(servers.length > 0 ? [{ type: "separator" } as const] : []),
		{ label: "Add server…", click: openSetup },
		...shownItems,
	];
}

function applicationMenu(): MenuItemConstructorOptions[] {
	return [
		...(process.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
		{ role: "fileMenu" },
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				// Not the reload role, so a server that couldn't be reached is tried
				// again rather than the page saying so being reloaded.
				{ label: "Reload", accelerator: "CommandOrControl+R", click: () => appWindow?.reload() },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ label: "Server", submenu: serverMenuItems() },
		{ role: "windowMenu" },
	];
}

function trayMenu(): MenuItemConstructorOptions[] {
	return [
		{ label: "Open Sugabots", click: openApp },
		{ type: "separator" },
		...serverMenuItems(),
		{ type: "separator" },
		{ label: "Quit Sugabots", click: () => app.quit() },
	];
}

function createTray(): Tray {
	const icon = nativeImage.createFromPath(trayIconPath);
	// macOS draws a tray image at its own size instead of fitting it to the menu bar.
	const image = process.platform === "darwin" ? icon.resize({ width: 16, height: 16 }) : icon;
	const tray = new Tray(image);
	tray.setToolTip("Sugabots");
	return tray;
}

// Before the single-instance lock, which lives in this folder, so a development
// build runs beside an installed copy without sharing its servers or settings.
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Sugabots Development"));

if (app.requestSingleInstanceLock()) {
	// Launching the app again reopens its window. That is the way back when the
	// desktop shows no tray, such as GNOME without the AppIndicator extension.
	app.on("second-instance", openApp);
	app.on("activate", openApp);
	// The app stays running when its windows close; the tray's Quit ends it.
	app.on("window-all-closed", () => {});

	// Not awaited: Electron emits `ready` only once this module has finished evaluating.
	void app.whenReady().then(async () => {
		saved = await loadSavedServers();
		tray = createTray();
		app.on("quit", () => tray?.destroy());
		serversChanged();
		openApp();
	});
} else {
	app.quit();
}
