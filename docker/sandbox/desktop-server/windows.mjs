// The windows on the desktop's display, which the web app draws a frame
// around, one each: the browser's, the apps' the agent started, their
// dialogs, and the menus and tooltips they pop up. The display never shows
// them overlapping: they're laid out apart, in rows, with room between them
// for their menus, so each shows whole and the web app can show it anywhere,
// over or under any other. The display grows to hold them. Viewers are told
// as windows open, close, change size or title. A viewer in control resizes,
// raises, minimizes and closes them, as it does their frames. Any viewer
// says which look, light or dark, it shows the desktop in: the last to say
// wins. Viewers are told the name of the display's pointer too, such as
// "text" over text, so the person's own pointer can take that shape.
//
// To the viewer, as JSON text, windows from the back to the front:
//   {type:"windows", windows:[{id, kind:"browser"|"app"|"popup", title, x, y, width, height, minimized, parent?}]}
//     in pixels on the display. A popup is a menu or tooltip, drawn without a
//     frame; `parent` is the window a dialog or popup belongs to.
//   {type:"cursor", name}
//     the pointer's name: as the app chose it, or the cursor theme's for a
//     pointer from the theme that the app gave none, as Chromium does; or ""
//     for one the app drew itself.
// From any viewer:
//   {type:"theme", scheme:"light"|"dark"}
// From a viewer in control:
//   {type:"size", id, width, height} | {type:"focus", id}
//   {type:"minimize", id} | {type:"close", id}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import x11 from "x11";
import { fingerprintOf, themePointers } from "./cursors.mjs";

const run = promisify(execFile);

/** How long the display may go unchanged before windows are looked at again, for titles, which say nothing when they change. */
const RESCAN_MS = 1000;
/** How long to gather the display's changes before looking at its windows, as a window opening makes several at once. */
const SETTLE_MS = 20;
const VIEWABLE = 2;
/** The room around each window on the display, in pixels, where its menus and tooltips open without covering another. */
const GAP = 320;
/** How wide a row of windows on the display grows before the next starts below it, in pixels. */
const ROW_WIDTH = 4096;
/** The smallest the display is, in pixels, which is what it starts at. */
const MIN_SCREEN = { width: 1280, height: 800 };

/** The windows on the display of the desktop of `session`, which this process's DISPLAY names. */
export async function makeWindows(session, theme) {
	const display = await connect();
	const viewers = new Set();
	let lastSent = "";
	let scanning = false;
	let rescan;
	let screen = MIN_SCREEN;

	/** Lays the windows out apart, growing or shrinking the display to hold them, and moves any that aren't where they go. */
	const arrange = async (windows) => {
		const layout = layOut(windows.filter(({ kind }) => kind !== "popup"));
		if (layout.width !== screen.width || layout.height !== screen.height) {
			// Grown first, so no window goes off the display.
			await run("sugabots-desktop", [
				"resize",
				session,
				"browser",
				String(layout.width),
				String(layout.height),
			]);
			screen = layout;
		}
		for (const window of windows) {
			const slot = layout.slots.get(window.id);
			if (slot && (slot.x !== window.x || slot.y !== window.y)) {
				await display.place(Number(window.id), slot);
			}
		}
	};

	const send = async () => {
		const windows = await display.windows();
		await arrange(windows);
		const message = JSON.stringify({ type: "windows", windows: withParents(windows) });
		if (message === lastSent) return;
		lastSent = message;
		for (const viewer of viewers) {
			if (viewer.readyState === WebSocket.OPEN) viewer.send(message);
		}
	};
	const scan = () => {
		if (scanning) return;
		scanning = true;
		setTimeout(() => {
			scanning = false;
			send().catch(report);
		}, SETTLE_MS);
	};
	display.onChange(scan);

	let cursorMessage = JSON.stringify({ type: "cursor", name: "" });
	display.onCursor((name) => {
		cursorMessage = JSON.stringify({ type: "cursor", name });
		for (const viewer of viewers) {
			if (viewer.readyState === WebSocket.OPEN) viewer.send(cursorMessage);
		}
	});

	/** What a viewer in control does to a window, if `message` is something it may do. */
	const act = (message) => {
		const id = Number(message?.id);
		if (!Number.isInteger(id) || id <= 0) return;
		switch (message.type) {
			case "size": {
				const [width, height] = [message.width, message.height].map((value) =>
					Math.round(Number(value)),
				);
				if (!(width > 0 && height > 0)) return;
				return display.place(id, { width, height });
			}
			case "focus":
				return run("xdotool", ["windowactivate", String(id)]);
			case "minimize":
				return run("xdotool", ["windowminimize", String(id)]);
			case "close":
				// Asks the app to close the window, as a window's own close button does.
				return run("wmctrl", ["-i", "-c", String(id)]);
		}
	};

	return {
		serve(viewer, mayUse) {
			viewers.add(viewer);
			if (viewers.size === 1) {
				lastSent = "";
				rescan = setInterval(scan, RESCAN_MS);
			} else if (lastSent) {
				viewer.send(lastSent);
			}
			viewer.send(cursorMessage);
			scan();
			viewer.on("close", () => {
				viewers.delete(viewer);
				if (viewers.size === 0) clearInterval(rescan);
			});
			viewer.on("message", (raw) => {
				let message;
				try {
					message = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (message?.type === "theme") return theme.set(message.scheme);
				if (!mayUse) return;
				Promise.resolve(act(message)).then(scan, report);
			});
		},
	};
}

/**
 * Where each window goes on the display, by its top left, so none overlaps
 * another or the room around it: in rows, oldest first, so a window keeps
 * its place as others open after it. And how big the display must be to
 * hold them, with room to spare at its bottom right, where nothing is.
 */
function layOut(windows) {
	const slots = new Map();
	let x = GAP;
	let y = GAP;
	let rowHeight = 0;
	let width = 0;
	for (const window of [...windows].sort((a, b) => Number(a.id) - Number(b.id))) {
		if (x > GAP && x + window.width + GAP > ROW_WIDTH) {
			x = GAP;
			y += rowHeight + GAP;
			rowHeight = 0;
		}
		slots.set(window.id, { x, y });
		x += window.width + GAP;
		rowHeight = Math.max(rowHeight, window.height);
		width = Math.max(width, x);
	}
	return {
		slots,
		width: Math.max(MIN_SCREEN.width, width),
		height: Math.max(MIN_SCREEN.height, y + rowHeight + GAP),
	};
}

/**
 * `windows`, each popup with the window it belongs to: the one it says, or
 * the one in whose room on the display it opened.
 */
function withParents(windows) {
	const framed = windows.filter(({ kind }) => kind !== "popup");
	const roomOf = (window, point) =>
		point.x >= window.x - GAP &&
		point.x < window.x + window.width + GAP &&
		point.y >= window.y - GAP &&
		point.y < window.y + window.height + GAP;
	return windows.map((window) => {
		if (window.kind !== "popup") return window;
		const parent =
			framed.find(({ id }) => id === window.parent) ??
			framed.find((other) => roomOf(other, window));
		const { parent: _, ...popup } = window;
		return parent ? { ...popup, parent: parent.id } : popup;
	});
}

/**
 * The X display named by DISPLAY: its windows, as the window manager lists
 * the apps', and the popups drawn over them, which it doesn't manage.
 */
async function connect() {
	const { client: X, screen } = await new Promise((resolve, reject) =>
		x11.createClient({ display: process.env.DISPLAY }, (error, display) =>
			error ? reject(error) : resolve(display),
		),
	);
	const root = screen[0].root;
	// A window that closes while it's being looked at answers with an error, which only leaves it out.
	X.on("error", () => {});
	const ask = (method, ...args) =>
		new Promise((resolve) =>
			X[method](...args, (error, result) => resolve(error ? undefined : result)),
		);
	const atom = (name) => ask("InternAtom", false, name);
	const atoms = {
		clients: await atom("_NET_CLIENT_LIST_STACKING"),
		name: await atom("_NET_WM_NAME"),
		state: await atom("_NET_WM_STATE"),
		filling: new Set(
			await Promise.all(
				[
					"_NET_WM_STATE_MAXIMIZED_VERT",
					"_NET_WM_STATE_MAXIMIZED_HORZ",
					"_NET_WM_STATE_FULLSCREEN",
				].map(atom),
			),
		),
	};
	const property = (window, name) => ask("GetProperty", 0, window, name, 0, 0, 1 << 16);
	const windowIds = (prop) =>
		prop
			? Array.from({ length: prop.data.length / 4 }, (_, index) =>
					prop.data.readUInt32LE(index * 4),
				)
			: [];

	/** Where `window` is on the display, and how big, if it's still there. */
	const bounds = async (window) => {
		const [geometry, position] = await Promise.all([
			ask("GetGeometry", window),
			ask("TranslateCoordinates", window, root, 0, 0),
		]);
		if (!geometry || !position) return undefined;
		return { x: position.destX, y: position.destY, width: geometry.width, height: geometry.height };
	};

	const titleOf = async (window) => {
		const named = (await property(window, atoms.name)) ?? (await property(window, X.atoms.WM_NAME));
		return named?.data.toString("utf8") ?? "";
	};

	const appWindow = async (window) => {
		const [attributes, place, title, wmClass, transientFor] = await Promise.all([
			ask("GetWindowAttributes", window),
			bounds(window),
			titleOf(window),
			property(window, X.atoms.WM_CLASS),
			property(window, X.atoms.WM_TRANSIENT_FOR),
		]);
		if (!attributes || !place) return undefined;
		const parent = windowIds(transientFor)[0];
		return {
			id: String(window),
			kind: /chromium/i.test(wmClass?.data.toString() ?? "") ? "browser" : "app",
			title,
			...place,
			minimized: attributes.mapState !== VIEWABLE,
			...(parent && { parent: String(parent) }),
		};
	};

	const popup = async (window) => {
		const attributes = await ask("GetWindowAttributes", window);
		if (!attributes?.overrideRedirect || attributes.mapState !== VIEWABLE) return undefined;
		const [place, transientFor] = await Promise.all([
			bounds(window),
			property(window, X.atoms.WM_TRANSIENT_FOR),
		]);
		// Toolkits keep 1×1 windows of their own mapped, which show nothing.
		if (!place || place.width <= 1 || place.height <= 1) return undefined;
		const parent = windowIds(transientFor)[0];
		return {
			id: String(window),
			kind: "popup",
			title: "",
			...place,
			minimized: false,
			...(parent && { parent: String(parent) }),
		};
	};

	return {
		async windows() {
			const [clients, tree] = await Promise.all([
				property(root, atoms.clients),
				ask("QueryTree", root),
			]);
			const apps = await Promise.all(windowIds(clients).map(appWindow));
			const popups = await Promise.all((tree?.children ?? []).map(popup));
			return [...apps, ...popups].filter(Boolean);
		},
		/** Calls `listener` when a window opens, closes or moves, or the apps' stacking changes. */
		onChange(listener) {
			X.ChangeWindowAttributes(root, {
				eventMask: x11.eventMask.SubstructureNotify | x11.eventMask.PropertyChange,
			});
			X.on("event", (event) => {
				if (event.name !== CURSOR_NOTIFY) listener(event);
			});
		},
		/**
		 * Calls `listener` with the pointer's name each time the display's
		 * pointer changes, through XFixes, whose cursor requests the x11 package
		 * doesn't have: SelectCursorInput, the CursorNotify event, which carries
		 * the name, and GetCursorImage, for the picture of a pointer without one.
		 */
		onCursor(listener) {
			const names = new Map();
			const theme = themePointers().catch((error) => {
				report(error);
				return new Map();
			});
			X.require("fixes", (error, fixes) => {
				if (error) return report(error);
				const pictureName = () =>
					new Promise((resolve) => {
						X.seq_num++;
						X.pack_stream.pack("CCS", [fixes.majorOpcode, XFIXES_GET_CURSOR_IMAGE, 1]);
						X.replies[X.seq_num] = [
							(reply) => {
								const width = reply.readUInt16LE(4);
								const height = reply.readUInt16LE(6);
								return {
									width,
									height,
									hotX: reply.readUInt16LE(8),
									hotY: reply.readUInt16LE(10),
									pixels: reply.subarray(24, 24 + width * height * 4),
								};
							},
							async (error, picture) =>
								resolve(error ? "" : ((await theme).get(fingerprintOf(picture)) ?? "")),
						];
						X.pack_stream.flush();
					});
				const nameOf = async (atom) => {
					if (atom === 0) return pictureName();
					if (!names.has(atom)) names.set(atom, (await ask("GetAtomName", atom)) ?? "");
					return names.get(atom);
				};
				X.eventParsers[fixes.firstEvent + XFIXES_CURSOR_NOTIFY] = (
					type,
					seq,
					_window,
					_code,
					raw,
				) => {
					const [, , name] = raw.unpack("LLL");
					return { type, seq, name: CURSOR_NOTIFY, cursorName: name };
				};
				X.on("event", (event) => {
					if (event.name === CURSOR_NOTIFY) nameOf(event.cursorName).then(listener, report);
				});
				X.seq_num++;
				X.pack_stream.pack("CCSLL", [
					fixes.majorOpcode,
					XFIXES_SELECT_CURSOR_INPUT,
					3,
					root,
					XFIXES_DISPLAY_CURSOR_NOTIFY_MASK,
				]);
				X.pack_stream.flush();
			});
		},
		/**
		 * Moves or sizes the app window `window`, through the window manager,
		 * which keeps it there. A window maximized or full screen, as Chromium
		 * opens one it last closed maximized, is restored first: the window
		 * manager keeps those filling the display, and the web app's frame
		 * fills the desktop itself.
		 */
		async place(window, change) {
			if (
				windowIds(await property(window, atoms.state)).some((state) => atoms.filling.has(state))
			) {
				await run("wmctrl", [
					"-i",
					"-r",
					String(window),
					"-b",
					"remove,maximized_vert,maximized_horz",
				]);
				await run("wmctrl", ["-i", "-r", String(window), "-b", "remove,fullscreen"]);
			}
			X.ConfigureWindow(window, change);
		},
	};
}

const CURSOR_NOTIFY = "CursorNotify";
// From the XFixes protocol: https://www.x.org/releases/X11R7.7/doc/fixesproto/fixesproto.txt
const XFIXES_SELECT_CURSOR_INPUT = 3;
const XFIXES_GET_CURSOR_IMAGE = 4;
const XFIXES_CURSOR_NOTIFY = 1;
const XFIXES_DISPLAY_CURSOR_NOTIFY_MASK = 1;

function report(error) {
	console.error(error);
}
