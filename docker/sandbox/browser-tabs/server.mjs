// The tabs of one display's browser, for Sugabots' web app, which draws the
// tabs and address bar the browser, in kiosk mode, doesn't: which tabs are
// open and which is in front, and, for a viewer in control, switching tabs
// and going to an address, back, forward or reloading. The page itself
// reaches viewers over VNC.
//
//   node server.mjs port devtools-port passwords-file
//
// Viewers open a WebSocket on `port` with `Authorization: Bearer <password>`,
// one of the two in `passwords-file`, as sugabots-desktop writes them: the
// first lets the viewer change the browser, the second only see its tabs.
// The file is read on every connection, because a display that starts again
// makes new ones. Viewers never speak DevTools themselves: this server takes
// only the messages below, so a viewer can't read the browser's cookies or
// run script in its pages.
//
// To the viewer, as JSON text:
//   {type:"tabs", tabs:[{id,title,url}], activeId}
// From a viewer in control:
//   {type:"activate", tabId}
//   {type:"navigate", url} | {type:"back"} | {type:"forward"} | {type:"reload"}

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const [port, devtoolsPort, passwordsFile] = process.argv.slice(2);
if (!port || !devtoolsPort || !passwordsFile) {
	console.error("usage: node server.mjs port devtools-port passwords-file");
	process.exit(2);
}

/**
 * How often the tab in front is looked for. DevTools says when tabs open,
 * close and navigate, but not when another comes to the front, as it does
 * when the agent switches tabs.
 */
const FRONT_TAB_CHECK_MS = 500;
const NAVIGABLE_PROTOCOLS = new Set(["http:", "https:"]);

const server = createServer((_request, response) => {
	response.writeHead(426).end();
});
const viewers = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
	const standing = standingOf(request.headers.authorization);
	if (!standing) {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	viewers.handleUpgrade(request, socket, head, (viewer) => {
		serve(viewer, standing === "control").catch((error) => {
			console.error("A viewer's connection failed:", error);
			viewer.close(1011);
		});
	});
});

server.listen(Number(port), "0.0.0.0");

/** Whether the header holds the password to use the browser or to watch it. */
function standingOf(authorization) {
	const given = authorization?.match(/^Bearer (.+)$/)?.[1];
	if (!given) return undefined;
	const [control, watch] = readFileSync(passwordsFile, "utf8").split("\n");
	if (matches(given, control)) return "control";
	if (matches(given, watch)) return "watch";
	return undefined;
}

function matches(given, password) {
	if (!password) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(password);
	return a.length === b.length && timingSafeEqual(a, b);
}

async function serve(viewer, mayUse) {
	const browser = await connectToBrowser();
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

/** A DevTools connection to the browser, with its pages reached through sessions. */
async function connectToBrowser() {
	const version = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`).then((response) =>
		response.json(),
	);
	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	let nextId = 1;
	const pending = new Map();
	const listeners = new Map();
	socket.on("message", (raw) => {
		const message = JSON.parse(String(raw));
		if (message.id !== undefined) {
			const waiting = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiting?.reject(new Error(message.error.message));
			else waiting?.resolve(message.result);
			return;
		}
		listeners.get(message.method)?.(message.params, message.sessionId);
	});
	socket.on("close", () => {
		for (const waiting of pending.values()) waiting.reject(new Error("The browser closed"));
		pending.clear();
	});
	return {
		send: (method, params = {}, sessionId) =>
			new Promise((resolve, reject) => {
				if (socket.readyState !== WebSocket.OPEN) return reject(new Error("The browser closed"));
				const id = nextId++;
				pending.set(id, { resolve, reject });
				socket.send(JSON.stringify({ id, method, params, sessionId }));
			}),
		on: (method, listener) => listeners.set(method, listener),
		onClose: (listener) => socket.on("close", listener),
		close: () => socket.close(),
	};
}
