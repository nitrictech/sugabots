// The desktop's terminal: one shell for everyone viewing the desktop, the way
// they share its displays, so people watching see what the person in control
// types. A viewer joining is sent what the terminal last showed.
//
// To the viewer: what the shell writes, as text.
// From a viewer in control, as JSON text:
//   {type:"input", data} | {type:"resize", cols, rows}

import { spawn } from "node-pty";
import { WebSocket } from "ws";

/** How much of what the shell wrote a viewer joining is sent: enough to fill a screen many times. */
const KEPT_OUTPUT_CHARACTERS = 200_000;

/** The terminal of a desktop, its shell starting in `folder` when someone in control first uses it. */
export function makeTerminal(folder, session) {
	const viewers = new Set();
	let shell;
	let kept = "";

	const start = () => {
		shell = spawn("bash", ["-l"], {
			name: "xterm-256color",
			cwd: folder,
			cols: 80,
			rows: 24,
			// Displays started from it are this desktop's windows.
			env: { ...process.env, SUGABOTS_DESKTOP_SESSION: session },
		});
		shell.onData((data) => {
			kept = (kept + data).slice(-KEPT_OUTPUT_CHARACTERS);
			for (const viewer of viewers) {
				if (viewer.readyState === WebSocket.OPEN) viewer.send(data);
			}
		});
		shell.onExit(() => {
			shell = undefined;
		});
	};

	return {
		serve(viewer, mayUse) {
			viewers.add(viewer);
			viewer.on("close", () => viewers.delete(viewer));
			if (mayUse && !shell) start();
			if (kept) viewer.send(kept);
			viewer.on("message", (raw) => {
				if (!mayUse) return;
				let message;
				try {
					message = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (!shell) start();
				if (message?.type === "input" && typeof message.data === "string") {
					shell.write(message.data);
				} else if (message?.type === "resize") {
					const cols = Math.trunc(Number(message.cols));
					const rows = Math.trunc(Number(message.rows));
					if (cols > 0 && rows > 0) shell.resize(cols, rows);
				}
			});
		},
	};
}
