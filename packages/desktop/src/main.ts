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
import { type SignInWatch, watchSignIn } from "./account.ts";
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
	type SavedWorkspace,
	ServerId,
	type SignIn,
	saveSavedServers,
	serverById,
	serverHost,
	serverLabel,
	serversGroupedByOrigin,
	serverUrl,
	withServerAdded,
	withServerOpened,
	withServerRemoved,
	withSignIn,
	withWorkspaceOpened,
	workspaceAt,
	workspaceUrl,
} from "./saved-servers.ts";
import { findServer, typedAddress } from "./server.ts";
import { type ConnectResult, setupChannels } from "./setup/bridge.ts";

/** For development: opens this server, in a session of its own, without asking or saving it. */
const serverOverride: ServerToShow | undefined = process.env.SUGABOTS_URL
	? { id: ServerId.make("sugabots-url"), url: process.env.SUGABOTS_URL }
	: undefined;

/** How many workspaces get a CmdOrCtrl+number shortcut. */
const WORKSPACE_SHORTCUT_COUNT = 9;

let saved: SavedServers = { servers: [] };
let appWindow: AppWindow | undefined;
/** The page the app window shows, which says which workspace is open. */
let shownUrl: string | undefined;
let setupWindow: BrowserWindow | undefined;
// Held for the app's lifetime, since a garbage-collected Tray disappears.
let tray: Tray | undefined;
/** One per saved server, so the menus list the workspaces of every account, not only the one open. */
const signInWatches = new Map<ServerId, SignInWatch>();

/** The app window, or the picker when no server has been added yet. */
function openApp() {
	if (appWindow) {
		appWindow.bringToFront();
		return;
	}
	const server = serverById(saved, saved.current);
	if (serverOverride) showServer(serverOverride);
	else if (server) showServer({ id: server.id, url: serverUrl(server) });
	else openSetup();
}

/** Saves `origin` again, with a session of its own for signing in to another account, and opens it. */
async function addServer(origin: string) {
	saved = withServerAdded(saved, origin);
	watchSignIns();
	openCurrentServer();
	await saveSavedServers(saved);
}

async function openWorkspace(server: SavedServer, workspace: SavedWorkspace) {
	if (appWindow?.serverId === server.id && shownWorkspace(server)?.slug === workspace.slug) {
		appWindow.bringToFront();
		// Clicking its menu item cleared that item's check mark.
		serversChanged();
		return;
	}
	saved = withWorkspaceOpened(saved, server.id, workspace.slug);
	showServer({ id: server.id, url: workspaceUrl(server, workspace) });
	await saveSavedServers(saved);
}

/** Opens the saved server `id` where it was left, for one with no workspace to open, such as one signed out. */
async function openServer(id: ServerId) {
	saved = withServerOpened(saved, id);
	openCurrentServer();
	await saveSavedServers(saved);
}

function openCurrentServer() {
	const server = serverById(saved, saved.current);
	if (server) showServer({ id: server.id, url: serverUrl(server) });
}

function showServer(server: ServerToShow) {
	// Two saves of one server share its addresses, so the last page would name a workspace of the other.
	if (appWindow?.serverId !== server.id) shownUrl = undefined;
	if (appWindow) appWindow.show(server);
	else appWindow = new AppWindow(server, appWindowEvents);
	appWindow.bringToFront();
	setupWindow?.close();
	serversChanged();
}

/** The workspace the app window shows of `server`, if it shows one. */
function shownWorkspace(server: SavedServer): SavedWorkspace | undefined {
	if (appWindow?.serverId !== server.id || !shownUrl) return undefined;
	return workspaceAt(server, shownUrl);
}

const appWindowEvents: AppWindowEvents = {
	title: (pageTitle, id) => {
		const server = serverById(saved, id);
		return server && saved.servers.length > 1
			? `${pageTitle} — ${serverLabel(saved, server)}`
			: pageTitle;
	},
	navigated: (id, url) => {
		const server = serverById(saved, id);
		const before = server && shownWorkspace(server);
		shownUrl = url;
		if (!server) return;
		const workspace = shownWorkspace(server);
		const moved = workspace?.slug !== before?.slug;
		// Making, renaming, leaving or deleting a workspace changes no cookie, but moves the page,
		// such as cancelling a new one's setup, which deletes it and goes back to the one before.
		if (moved || !workspace) signInWatches.get(id)?.recheck();
		if (!moved) return;
		if (workspace) {
			saved = withWorkspaceOpened(saved, id, workspace.slug);
			void saveSavedServers(saved);
		}
		serversChanged();
	},
	switchWorkspace: () => {
		Menu.buildFromTemplate(workspaceMenuItems()).popup({ window: appWindow?.window });
	},
	closed: () => {
		appWindow = undefined;
		shownUrl = undefined;
		serversChanged();
	},
};

/** Starts watching who each saved server is signed in as, and stops for those removed. */
function watchSignIns() {
	for (const server of saved.servers) {
		if (signInWatches.has(server.id)) continue;
		const watch = watchSignIn(savedServerSession(server.id), server.origin, (signIn) =>
			signedIn(server.id, signIn),
		);
		signInWatches.set(server.id, watch);
	}
	for (const [id, watch] of signInWatches) {
		if (serverById(saved, id)) continue;
		watch.stop();
		signInWatches.delete(id);
	}
}

function signedIn(id: ServerId, signIn: SignIn | undefined) {
	const updated = withSignIn(saved, id, signIn);
	if (updated === saved) return;
	saved = updated;
	serversChanged();
	void saveSavedServers(saved);
}

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
	watchSignIns();
	if (appWindow?.serverId === server.id) {
		const next = serverById(saved, saved.current);
		if (next) showServer({ id: next.id, url: serverUrl(next) });
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

/** Asks for a server's address, filled in with the open server's, `openOrigin`, when adding another account. */
function openSetup(openOrigin?: string) {
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
	const query: Record<string, string> = openOrigin ? { address: typedAddress(openOrigin) } : {};
	void loadLocalPage(setupWindow.webContents, "setup", query);
}

/** Menus list the saved servers' workspaces, so they're rebuilt whenever those or the one open change. */
function serversChanged() {
	Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu()));
	tray?.setContextMenu(Menu.buildFromTemplate(trayMenu()));
	appWindow?.refreshTitle();
}

/**
 * Every workspace of every saved account, by name, each account's between
 * separators, then adding an account and removing the open one. A name two
 * workspaces share also says which server and account each is on. An account
 * with no workspace, such as one signed out, is an entry of its own. With only
 * one place to go, the list is left out.
 *
 * The entries are checkboxes, not radio items, because Electron checks the
 * first of a radio group with none checked, as when the page is in no workspace.
 */
function workspaceMenuItems(): MenuItemConstructorOptions[] {
	const shown = serverById(saved, appWindow?.serverId ?? saved.current);
	const servers = serversGroupedByOrigin(saved);
	const names = servers.flatMap((server) => (server.workspaces ?? []).map(({ name }) => name));
	const sharedNames = new Set(names.filter((name, index) => names.indexOf(name) !== index));
	let shortcuts = 0;
	const nextShortcut = () =>
		++shortcuts <= WORKSPACE_SHORTCUT_COUNT ? `CommandOrControl+${shortcuts}` : undefined;
	const groups = servers.map((server): MenuItemConstructorOptions[] => {
		const workspaces = server.workspaces ?? [];
		if (workspaces.length === 0) {
			return [
				{
					label: server.account
						? serverLabel(saved, server)
						: `Sign in to ${serverHost(server.origin)}…`,
					type: "checkbox",
					checked: server === shown,
					accelerator: nextShortcut(),
					click: () => void openServer(server.id),
				},
			];
		}
		const open = server === shown ? shownWorkspace(server) : undefined;
		return workspaces.map(
			(workspace): MenuItemConstructorOptions => ({
				label: sharedNames.has(workspace.name)
					? `${workspace.name} (${serverLabel(saved, server)})`
					: workspace.name,
				type: "checkbox",
				checked: workspace.slug === open?.slug,
				accelerator: nextShortcut(),
				click: () => void openWorkspace(server, workspace),
			}),
		);
	});
	const removeShown: MenuItemConstructorOptions[] = shown
		? [{ label: `Remove ${serverLabel(saved, shown)}…`, click: () => void removeServer(shown) }]
		: [];
	const places = groups.flatMap((group) => [...group, { type: "separator" } as const]);
	return [
		...(groups.flat().length > 1 ? places : []),
		{ label: "Add another account…", click: () => openSetup(shown?.origin) },
		...removeShown,
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
		{ label: "Workspace", submenu: workspaceMenuItems() },
		{ role: "windowMenu" },
	];
}

function trayMenu(): MenuItemConstructorOptions[] {
	return [
		{ label: "Open Sugabots", click: openApp },
		{ type: "separator" },
		...workspaceMenuItems(),
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
		watchSignIns();
		tray = createTray();
		app.on("quit", () => tray?.destroy());
		serversChanged();
		openApp();
	});
} else {
	app.quit();
}
