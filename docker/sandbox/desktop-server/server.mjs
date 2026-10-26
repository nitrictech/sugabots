// What Sugabots' web app reaches an agent's desktop through besides its
// displays, which it reaches over VNC: the browser's tabs, the terminal, the
// files, and which windows the desktop has.
//
//   node server.mjs port devtools-port passwords-file session folder
//
// Viewers open a WebSocket on `port`, at /tabs, /terminal, /files or
// /windows, with `Authorization: Bearer <password>`, one of the two in
// `passwords-file`, as sugabots-desktop writes them: the first lets the
// viewer change things, the second only watch. The file is read on every
// connection, because a display that starts again makes new ones. Viewers
// never speak DevTools themselves, so a viewer can't read the browser's
// cookies or run script in its pages.
// `session` is the desktop's name to sugabots-desktop, and `folder` where its
// terminal and file browser start.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { serveFiles } from "./files.mjs";
import { serveTabs } from "./tabs.mjs";
import { makeTerminal } from "./terminal.mjs";
import { makeWindows } from "./windows.mjs";

const [port, devtoolsPort, passwordsFile, session, folder] = process.argv.slice(2);
if (!port || !devtoolsPort || !passwordsFile || !session || !folder) {
	console.error("usage: node server.mjs port devtools-port passwords-file session folder");
	process.exit(2);
}

const terminal = makeTerminal(folder, session);
const windows = makeWindows(session);
const channels = {
	"/tabs": (viewer, mayUse) => serveTabs(viewer, mayUse, devtoolsPort),
	"/terminal": (viewer, mayUse) => terminal.serve(viewer, mayUse),
	"/files": (viewer, mayUse) => serveFiles(viewer, mayUse, folder),
	"/windows": (viewer, mayUse) => windows.serve(viewer, mayUse),
};

const server = createServer((_request, response) => {
	response.writeHead(426).end();
});
const viewers = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
	const channel = channels[new URL(request.url ?? "/", "http://localhost").pathname];
	if (!channel) {
		socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
		return;
	}
	const standing = standingOf(request.headers.authorization);
	if (!standing) {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	viewers.handleUpgrade(request, socket, head, (viewer) => {
		Promise.resolve(channel(viewer, standing === "control")).catch((error) => {
			console.error("A viewer's connection failed:", error);
			viewer.close(1011);
		});
	});
});

server.listen(Number(port), "0.0.0.0");

/** Whether the header holds the password to use the desktop or to watch it. */
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
