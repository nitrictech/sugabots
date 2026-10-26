// The browser's tabs, for the web app, which draws the tabs and address bar
// the browser, in kiosk mode, doesn't: which tabs are open and which is in
// front, and, for a viewer in control, switching tabs and going to an
// address, back, forward or reloading.
//
// To the viewer, as JSON text:
//   {type:"tabs", tabs:[{id,title,url}], activeId}
// From a viewer in control:
//   {type:"activate", tabId}
//   {type:"navigate", url} | {type:"back"} | {type:"forward"} | {type:"reload"}

import { WebSocket } from "ws";
import { connectToBrowser } from "./devtools.mjs";

/**
 * How often the tab in front is looked for. DevTools says when tabs open,
 * close and navigate, but not when another comes to the front, as it does
 * when the agent switches tabs.
 */
const FRONT_TAB_CHECK_MS = 500;
const NAVIGABLE_PROTOCOLS = new Set(["http:", "https:"]);

/** Keeps `viewer` told of the tabs of the browser on DevTools port `devtoolsPort`. */
export async function serveTabs(viewer, mayUse, devtoolsPort) {
	const browser = await connectToBrowser(devtoolsPort);
	/** Each tab's DevTools details, and the session this connection reaches its page through. */
	const tabs = new Map();
	let frontId;
	let lastSent = "";

	const sendTabs = () => {
		const message = JSON.stringify({
			type: "tabs",
			tabs: [...tabs.values()].map(({ info }) => ({
				id: info.targetId,
				title: info.title,
				url: info.url,
			})),
			activeId: frontId,
		});
		if (message === lastSent || viewer.readyState !== WebSocket.OPEN) return;
		lastSent = message;
		viewer.send(message);
	};

	const add = async (info) => {
		if (info.type !== "page" || tabs.has(info.targetId)) return;
		tabs.set(info.targetId, { info, sessionId: undefined });
		const { sessionId } = await browser.send("Target.attachToTarget", {
			targetId: info.targetId,
			flatten: true,
		});
		const tab = tabs.get(info.targetId);
		if (tab) tab.sessionId = sessionId;
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
		tab.info = targetInfo;
		sendTabs();
	});
	browser.on("Target.targetDestroyed", ({ targetId }) => {
		if (tabs.delete(targetId)) sendTabs();
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
		const front = tabs.get(frontId);
		use(browser, front, message)
			?.then(() => findFront())
			.catch(report);
	});
}

/** What a viewer in control does to the browser, if `message` is something it may do. */
function use(browser, front, message) {
	switch (message?.type) {
		case "activate":
			return browser.send("Target.activateTarget", { targetId: String(message.tabId) });
		case "navigate": {
			const url = navigable(String(message.url ?? ""));
			if (!url || !front?.sessionId) return;
			return browser.send("Page.navigate", { url }, front.sessionId);
		}
		case "back":
		case "forward":
			if (!front?.sessionId) return;
			return browser.send(
				"Runtime.evaluate",
				{ expression: message.type === "back" ? "history.back()" : "history.forward()" },
				front.sessionId,
			);
		case "reload":
			if (!front?.sessionId) return;
			return browser.send("Page.reload", {}, front.sessionId);
	}
}

/** The web address a person typed, as the browser's own bar would read it, if it's a web page. */
function navigable(typed) {
	const trimmed = typed.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
		return NAVIGABLE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function report(error) {
	console.error(error);
}
