// The browser's tabs, for the web app, which draws the tabs and toolbar the
// browser, in kiosk mode, doesn't: which tabs are open and which is in
// front, whether each is loading and can go back or forward, and its icon;
// and, for a viewer in control, switching, opening and closing tabs, and
// going to an address, back, forward, reloading or stopping.
//
// To the viewer, as JSON text:
//   {type:"tabs", activeId, tabs:[{id, title, url, icon, loading, canGoBack, canGoForward}]}
//     icon is a data: URL, fetched here so the viewer's own browser never asks
//     the sites the agent visits for anything.
// From a viewer in control:
//   {type:"activate", tabId} | {type:"newTab"} | {type:"closeTab", tabId}
//   {type:"navigate", url} | {type:"back"} | {type:"forward"} | {type:"reload"} | {type:"stop"}

import { WebSocket } from "ws";
import { connectToBrowser } from "./devtools.mjs";

/**
 * How often the tab in front is looked for. DevTools says when tabs open,
 * close and navigate, but not when another comes to the front, as it does
 * when the agent switches tabs.
 */
const FRONT_TAB_CHECK_MS = 500;
const NAVIGABLE_PROTOCOLS = new Set(["http:", "https:"]);
const NEW_TAB_URL = "about:blank";
/** Where words typed into the address bar are searched for, as the browser's own bar would. */
const SEARCH_URL = "https://duckduckgo.com/?q=";
const MAX_ICON_BYTES = 100 * 1024;
const ICON_TIMEOUT_MS = 3000;
const LATE_ICON_DELAY_MS = 1500;

/** Icons fetched so far, by their address, shared by every viewer. */
const icons = new Map();

/** Keeps `viewer` told of the tabs of the browser on DevTools port `devtoolsPort`. */
export async function serveTabs(viewer, mayUse, devtoolsPort) {
	const browser = await connectToBrowser(devtoolsPort);
	/**
	 * Each tab's DevTools details, the session this connection reaches its
	 * page through, and what the viewer is told of it besides.
	 */
	const tabs = new Map();
	let frontId;
	let lastSent = "";

	const sendTabs = () => {
		const message = JSON.stringify({
			type: "tabs",
			tabs: [...tabs.values()].map((tab) => ({
				id: tab.info.targetId,
				title: tab.info.title,
				url: tab.info.url,
				icon: tab.iconUrl ? icons.get(tab.iconUrl) : undefined,
				loading: tab.loading,
				canGoBack: tab.canGoBack,
				canGoForward: tab.canGoForward,
			})),
			activeId: frontId,
		});
		if (message === lastSent || viewer.readyState !== WebSocket.OPEN) return;
		lastSent = message;
		viewer.send(message);
	};

	const tabOfSession = (sessionId) => [...tabs.values()].find((tab) => tab.sessionId === sessionId);

	/** Brings the tab's history and icon up to date, after it has loaded or navigated. */
	const refresh = async (tab) => {
		if (!tab.sessionId || tabs.get(tab.info.targetId) !== tab) return;
		const { currentIndex, entries } = await browser.send(
			"Page.getNavigationHistory",
			{},
			tab.sessionId,
		);
		tab.canGoBack = currentIndex > 0;
		tab.canGoForward = currentIndex < entries.length - 1;
		tab.iconUrl = await iconUrlOf(devtoolsPort, tab.info.targetId);
		if (tab.iconUrl) await fetchIcon(tab.iconUrl);
		sendTabs();
	};

	const add = async (info) => {
		if (info.type !== "page" || tabs.has(info.targetId)) return;
		const tab = {
			info,
			sessionId: undefined,
			loading: false,
			canGoBack: false,
			canGoForward: false,
		};
		tabs.set(info.targetId, tab);
		const { sessionId } = await browser.send("Target.attachToTarget", {
			targetId: info.targetId,
			flatten: true,
		});
		tab.sessionId = sessionId;
		await browser.send("Page.enable", {}, sessionId);
		await refresh(tab);
	};

	const findFront = async () => {
		for (const [id, { sessionId }] of tabs) {
			if (!sessionId) continue;
			const visible = await browser
				.send(
					"Runtime.evaluate",
					{ expression: "document.visibilityState", returnByValue: true },
					sessionId,
				)
				.then(
					({ result }) => result.value === "visible",
					() => false,
				);
			if (visible) {
				frontId = id;
				break;
			}
		}
		sendTabs();
	};

	browser.on("Target.targetCreated", ({ targetInfo }) => add(targetInfo).catch(report));
	browser.on("Target.targetInfoChanged", ({ targetInfo }) => {
		const tab = tabs.get(targetInfo.targetId);
		if (!tab) return;
		const navigated = tab.info.url !== targetInfo.url;
		tab.info = targetInfo;
		sendTabs();
		if (navigated) refresh(tab).catch(report);
	});
	browser.on("Target.targetDestroyed", ({ targetId }) => {
		if (tabs.delete(targetId)) sendTabs();
	});
	// A tab's main frame has the tab's own id.
	browser.on("Page.frameStartedLoading", ({ frameId }, sessionId) => {
		const tab = tabOfSession(sessionId);
		if (!tab || frameId !== tab.info.targetId) return;
		tab.loading = true;
		sendTabs();
	});
	browser.on("Page.frameStoppedLoading", ({ frameId }, sessionId) => {
		const tab = tabOfSession(sessionId);
		if (!tab || frameId !== tab.info.targetId) return;
		tab.loading = false;
		sendTabs();
		refresh(tab).catch(report);
		// Pages often name their icon a moment after they finish loading.
		setTimeout(() => refresh(tab).catch(report), LATE_ICON_DELAY_MS);
	});

	const { targetInfos } = await browser.send("Target.getTargets");
	await Promise.all(targetInfos.map(add));
	await browser.send("Target.setDiscoverTargets", { discover: true });
	await findFront();
	const frontCheck = setInterval(() => findFront().catch(report), FRONT_TAB_CHECK_MS);

	viewer.on("close", () => {
		clearInterval(frontCheck);
		browser.close();
	});
	browser.onClose(() => viewer.close());
	viewer.on("message", (raw) => {
		if (!mayUse) return;
		let message;
		try {
			message = JSON.parse(String(raw));
		} catch {
			return;
		}
		use(browser, tabs, tabs.get(frontId), message)
			?.then(() => findFront())
			.catch(report);
	});
}

/** What a viewer in control does to the browser, if `message` is something it may do. */
async function use(browser, tabs, front, message) {
	switch (message?.type) {
		case "activate":
			return browser.send("Target.activateTarget", { targetId: String(message.tabId) });
		case "newTab":
			return browser.send("Target.createTarget", { url: NEW_TAB_URL });
		case "closeTab": {
			const tabId = String(message.tabId);
			if (!tabs.has(tabId)) return;
			// The browser, in kiosk mode, quits with its last tab, so a new one opens first.
			if (tabs.size === 1) await browser.send("Target.createTarget", { url: NEW_TAB_URL });
			return browser.send("Target.closeTarget", { targetId: tabId });
		}
	}
	if (!front?.sessionId) return;
	switch (message?.type) {
		case "navigate": {
			const url = addressFor(String(message.url ?? ""));
			if (!url) return;
			return browser.send("Page.navigate", { url }, front.sessionId);
		}
		case "back":
		case "forward": {
			const { currentIndex, entries } = await browser.send(
				"Page.getNavigationHistory",
				{},
				front.sessionId,
			);
			const entry = entries[currentIndex + (message.type === "back" ? -1 : 1)];
			if (!entry) return;
			return browser.send("Page.navigateToHistoryEntry", { entryId: entry.id }, front.sessionId);
		}
		case "reload":
			return browser.send("Page.reload", {}, front.sessionId);
		case "stop":
			return browser.send("Page.stopLoading", {}, front.sessionId);
	}
}

/**
 * Where what a person typed into the address bar goes, as the browser's own
 * bar would read it: a web address, or a search for anything that isn't one.
 */
function addressFor(typed) {
	const trimmed = typed.trim();
	if (!trimmed) return undefined;
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	const looksLikeHost =
		!/\s/.test(trimmed) && (trimmed.includes(".") || trimmed.startsWith("localhost"));
	if (!hasScheme && !looksLikeHost) return SEARCH_URL + encodeURIComponent(trimmed);
	try {
		const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
		return NAVIGABLE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** The address of the tab's icon, as the browser lists it, if it has one. */
async function iconUrlOf(devtoolsPort, targetId) {
	const listed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) =>
		response.json(),
	);
	const url = listed.find((target) => target.id === targetId)?.faviconUrl;
	return typeof url === "string" && /^(https?|data):/.test(url) ? url : undefined;
}

/** Fetches the icon at `url` once, kept as a data: URL, or nothing if it can't be had. */
async function fetchIcon(url) {
	if (icons.has(url)) return;
	icons.set(url, undefined);
	if (url.startsWith("data:")) {
		icons.set(url, url);
		return;
	}
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
		const bytes = Buffer.from(await response.arrayBuffer());
		const type = response.headers.get("content-type")?.split(";")[0] ?? "image/x-icon";
		if (!response.ok || bytes.length > MAX_ICON_BYTES || !type.startsWith("image/")) return;
		icons.set(url, `data:${type};base64,${bytes.toString("base64")}`);
	} catch {
		// Left without an icon, as a tab whose site gives none is.
	}
}

function report(error) {
	console.error(error);
}
