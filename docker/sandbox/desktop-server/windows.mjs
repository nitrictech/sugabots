// The desktop's windows that run on displays: the browser, and the apps an
// agent started, each on a display of its own, as `sugabots-desktop windows`
// says. Viewers are told when they change, and a viewer in control can close
// an app's window, which stops its display. Any viewer says which look, light
// or dark, it shows the desktop in.
//
// To the viewer, as JSON text:
//   {type:"windows", windows:[{id, kind:"browser"|"app", title}]}
// From any viewer:
//   {type:"theme", scheme:"light"|"dark"}
// From a viewer in control:
//   {type:"close", id}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const run = promisify(execFile);

/** How often the desktop's displays are looked at for windows that opened, closed or changed title. */
const WINDOWS_CHECK_MS = 1000;

/** The windows of the desktop of `session`. */
export function makeWindows(session, theme) {
	const viewers = new Set();
	let windows = [];
	let lastSent = "";
	let checking;

	const list = async () => {
		const { stdout } = await run("sugabots-desktop", ["windows", session]);
		return stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const { id, kind, display, title } = line.match(
					/^id=(?<id>\S+) kind=(?<kind>\S+) display=(?<display>\d+) title=(?<title>.*)$/,
				).groups;
				return { id, kind, display, title };
			});
	};

	const check = async () => {
		windows = await list();
		const message = JSON.stringify({
			type: "windows",
			windows: windows.map(({ id, kind, title }) => ({ id, kind, title })),
		});
		if (message === lastSent) return;
		lastSent = message;
		for (const viewer of viewers) {
			if (viewer.readyState === WebSocket.OPEN) viewer.send(message);
		}
	};

	const act = (message) => {
		if (message?.type === "close") {
			const window = windows.find(({ id }) => id === message.id);
			// The browser is the agent's, and stays open while the desktop does.
			if (!window || window.kind === "browser") return;
			return run("sugabots-desktop", ["stop", window.display]);
		}
	};

	return {
		serve(viewer, mayUse) {
			viewers.add(viewer);
			// The windows last sent are current only while someone was being kept told of them.
			if (checking) {
				if (lastSent) viewer.send(lastSent);
			} else {
				lastSent = "";
				checking = setInterval(() => check().catch(report), WINDOWS_CHECK_MS);
			}
			viewer.on("close", () => {
				viewers.delete(viewer);
				if (viewers.size > 0) return;
				clearInterval(checking);
				checking = undefined;
			});
			check().catch(report);
			viewer.on("message", (raw) => {
				let message;
				try {
					message = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (message?.type === "theme") return theme.set(message.scheme);
				if (!mayUse) return;
				act(message)
					?.then(() => check())
					.catch(report);
			});
		},
	};
}

function report(error) {
	console.error(error);
}
