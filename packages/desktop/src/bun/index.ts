import { DESKTOP_DEVICE_GLOBAL, type LocalAgentKind } from "@sugabots/contracts/devices";
import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from "electrobun/main";
import type { SetupRPC } from "../shared/rpc.ts";
import { type DeviceLink, startDeviceLink } from "./device-link.ts";
import type { ApproveToolUse } from "./hosted-agents/claude-code.ts";
import { agentOrigin, startAgentHost } from "./hosted-agents/host.ts";
import { findInstalledAgents, type LentAgent, lentAgent } from "./local-agents.ts";
import { startPairing } from "./pairing.ts";
import { findServer } from "./server.ts";
import {
	loadAgents,
	loadDeviceToken,
	loadServer,
	loadSessions,
	saveAgents,
	saveDeviceToken,
	saveServer,
	saveSessions,
} from "./settings.ts";

/** For development: opens this server without asking or saving it. */
const serverOverride = process.env.SUGABOTS_URL;

let appWindow: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
/** Which of the person's devices this computer is, once paired and connected. */
let thisDevice: string | null = null;
/** The link to the server this computer is paired with, while it is. */
let deviceLink: DeviceLink | undefined;

async function currentServer() {
	return serverOverride ?? (await loadServer());
}

/** The chosen server's window, or the picker when there is none yet. */
async function openApp() {
	if (appWindow) {
		appWindow.show();
		appWindow.activate();
		return;
	}
	const server = await currentServer();
	if (server) openServer(server);
	else openSetup();
}

/** The app window at `url`, a page of the chosen server's web app. */
function openServer(url: string) {
	if (appWindow) {
		appWindow.webview.loadURL(url);
		appWindow.show();
		appWindow.activate();
	} else {
		appWindow = new BrowserWindow({
			title: "Sugabots",
			url,
			frame: { width: 1280, height: 820 },
			// The window shows a remote site and should be sandboxed, but on Linux Electrobun
			// 2.0.2 closes a sandboxed window as soon as it opens. Until then it gets no `rpc`.
			sandbox: false,
		});
		appWindow.on("close", () => {
			appWindow = undefined;
			quitWithoutTray();
		});
		// Each page load starts without it.
		appWindow.webview.on("dom-ready", announceThisDevice);
	}
	setupWindow?.close();
}

/**
 * Tells the web app in the app window which device it is running on, so it
 * offers lending this computer's agents there and nowhere else. One way only:
 * the page learns a device id, and gets no way to reach this process.
 */
function announceThisDevice() {
	const name = JSON.stringify(DESKTOP_DEVICE_GLOBAL);
	appWindow?.webview.executeJavascript(
		`window[${name}] = ${JSON.stringify(thisDevice)}; window.dispatchEvent(new Event(${name}));`,
	);
}

function identify(deviceId: string | null) {
	if (thisDevice === deviceId) return;
	thisDevice = deviceId;
	announceThisDevice();
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
					currentServer: async () => (await currentServer()) ?? null,
					connect: async ({ address }) => {
						const found = await findServer(address);
						if (!found.ok) return found;
						await saveServer(found.origin);
						await startLink();
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

/**
 * Asks the person at this computer whether to lend an agent of `kind`, which
 * somebody asked for from the web app, and in which folder. Their answer here
 * is the only thing that lends one: the web app can ask, never decide.
 */
async function askToLend(kind: LocalAgentKind): Promise<LentAgent | undefined> {
	const installed = (await findInstalledAgents()).find((agent) => agent.kind === kind);
	if (!installed) return undefined;
	const { response } = await Utils.showMessageBox({
		type: "question",
		title: "Sugabots",
		message: `Lend ${installed.name} to Sugabots?`,
		detail: `Bots you set up will be able to ask ${installed.name} to work in a folder you choose next, as you, while this app is running. It asks you here before doing anything your ${installed.name} settings don't already allow.`,
		buttons: ["Don't lend", "Choose a folder…"],
		defaultId: 1,
		cancelId: 0,
	});
	if (response !== 1) return undefined;
	const [folder] = await Utils.openFileDialog({
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});
	if (!folder) return undefined;
	const lent = lentAgent(installed, folder);
	await lend([...(await loadAgents()), lent]);
	return lent;
}

async function stopLending(url: string) {
	await lend((await loadAgents()).filter((agent) => agentOrigin(agent.id) !== url));
}

async function lend(agents: ReadonlyArray<LentAgent>) {
	await saveAgents(agents);
	agentHost.lend(agents);
	deviceLink?.lend(agents);
}

/**
 * Asks the person at this computer, natively and every time, whether a lent
 * agent may use a tool its Claude Code settings don't already allow. Nobody
 * in Sugabots can answer for them.
 */
const approveToolUse: ApproveToolUse = async ({ agentName, toolName, input }) => {
	const { response } = await Utils.showMessageBox({
		type: "question",
		title: "Sugabots",
		message: `${agentName} wants to use ${toolName}`,
		detail: describeInput(input),
		buttons: ["Deny", "Allow"],
		defaultId: 0,
		cancelId: 0,
	});
	return response === 1;
};

const SHOWN_INPUT_LENGTH = 800;

function describeInput(input: Record<string, unknown>) {
	const shown = JSON.stringify(input, null, 2);
	return shown.length > SHOWN_INPUT_LENGTH ? `${shown.slice(0, SHOWN_INPUT_LENGTH)}…` : shown;
}

const sessions = await loadSessions();
const agentHost = startAgentHost({
	agents: await loadAgents(),
	approve: approveToolUse,
	// Through whichever link is open when a run asks.
	tools: {
		list: (asked) => deviceLink?.list(asked) ?? Promise.resolve([]),
		call: (asked, name, input) =>
			deviceLink?.call(asked, name, input) ??
			Promise.resolve({ text: "This computer isn't connected to Sugabots.", isError: true }),
	},
	sessions: {
		get: (agentId, contextId) => sessions[agentId]?.[contextId],
		set: (agentId, contextId, sessionId) => {
			sessions[agentId] = { ...sessions[agentId], [contextId]: sessionId };
			void saveSessions(sessions);
		},
	},
});

/** (Re)connects to the current server with this computer's token for it, if it has one. */
async function startLink() {
	deviceLink?.stop();
	deviceLink = undefined;
	identify(null);
	const server = await currentServer();
	const token = server && (await loadDeviceToken(server));
	if (server && token) {
		deviceLink = startDeviceLink({
			server,
			token,
			agents: await loadAgents(),
			installed: await findInstalledAgents(),
			host: agentHost,
			askToLend,
			stopLending: (url) => void stopLending(url),
			identified: identify,
		});
	}
	updateTrayMenu(Boolean(token));
}

/**
 * Pairs this computer with the current server: asks for a code, then opens
 * the web app's page where the person approves it. The link keeps trying
 * until they do.
 */
async function pair() {
	const server = await currentServer();
	if (!server) return openSetup();
	const pairing = await startPairing(server);
	if (!pairing.ok) {
		await Utils.showMessageBox({ type: "error", title: "Sugabots", message: pairing.message });
		return;
	}
	await saveDeviceToken({ server, token: pairing.token });
	await startLink();
	openServer(pairing.approvalUrl);
}

/** Forgets this computer's token, here only; the server keeps the device until it's removed there. */
async function unpair() {
	await saveDeviceToken(undefined);
	await startLink();
}

/** Without a tray there would be no way back to a closed app, so closing its last window quits it. */
function quitWithoutTray() {
	if (tray.id === 0 && !appWindow && !setupWindow) Utils.quit();
}

const tray = new Tray({ image: "views://assets/sugabots-logo.svg", template: false });
// Tray leaves its id at 0 when the desktop has no tray (GNOME without the
// AppIndicator extension, or Windows until there is an .ico).
if (tray.id === 0) console.warn("No system tray; closing the window quits Sugabots.");
function updateTrayMenu(paired: boolean) {
	tray.setMenu([
		{ type: "normal", label: "Open Sugabots", action: "open" },
		{ type: "normal", label: "Change server…", action: "change-server" },
		{ type: "divider" },
		paired
			? { type: "normal", label: "Unpair this computer", action: "unpair" }
			: { type: "normal", label: "Pair this computer…", action: "pair" },
		{ type: "divider" },
		{ type: "normal", label: "Quit Sugabots", action: "quit" },
	]);
}
tray.on("tray-clicked", (event) => {
	const { action } = (event as { data: { action: string } }).data;
	if (action === "open") openApp();
	if (action === "change-server") openSetup();
	if (action === "pair") pair();
	if (action === "unpair") unpair();
	if (action === "quit") Utils.quit();
});

// Links the app opens in a new tab, such as docs and provider sign-ins, belong in the person's browser.
Electrobun.events.on("new-window-open", (event: { data: { detail: unknown } }) => {
	const { detail } = event.data;
	const url = typeof detail === "string" ? detail : (detail as { url: string }).url;
	Utils.openExternal(url);
});

await startLink();
await openApp();
