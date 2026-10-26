// The desktop's files, for the web app's file browser: what is in a folder,
// and what a file holds, for a viewer in control, as the agents' user sees
// them. A viewer who only watches is told to take over, since a file browser
// reads whatever it's pointed at.
//
// From a viewer in control, as JSON text:
//   {type:"list", path} | {type:"read", path}
// To the viewer:
//   {type:"listing", path, entries:[{name, kind:"folder"|"file", size, modified}]}
//   {type:"file", path, mediaType, data:<base64>, truncated}
//   {type:"refused", path, reason}

import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { WebSocket } from "ws";

/** How much of a file is sent to be shown: enough for a long text file or a photo. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

const MEDIA_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/** Answers `viewer`'s requests for folders and files, relative paths resolving from `folder`. */
export function serveFiles(viewer, mayUse, folder) {
	const send = (message) => {
		if (viewer.readyState === WebSocket.OPEN) viewer.send(JSON.stringify(message));
	};
	viewer.on("message", async (raw) => {
		let message;
		try {
			message = JSON.parse(String(raw));
		} catch {
			return;
		}
		const path = resolve(folder, String(message?.path ?? "."));
		if (!mayUse) {
			return send({ type: "refused", path, reason: "Take over to browse the files." });
		}
		try {
			if (message?.type === "list") send(await listing(path));
			else if (message?.type === "read") send(await contents(path));
		} catch (error) {
			send({ type: "refused", path, reason: reasonFor(error) });
		}
	});
}

async function listing(path) {
	const real = await realpath(path);
	const names = await readdir(real);
	const entries = await Promise.all(
		names.map(async (name) => {
			const found = await stat(resolve(real, name)).catch(() => undefined);
			return {
				name,
				kind: found?.isDirectory() ? "folder" : "file",
				size: found?.size ?? 0,
				modified: found?.mtime.toISOString() ?? null,
			};
		}),
	);
	return { type: "listing", path: real, entries };
}

async function contents(path) {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const data = buffer.subarray(0, bytesRead);
		const mediaType =
			MEDIA_TYPES[extname(path).toLowerCase()] ??
			(looksLikeText(data) ? "text/plain" : "application/octet-stream");
		return {
			type: "file",
			path,
			mediaType,
			data: mediaType === "application/octet-stream" ? "" : data.toString("base64"),
			truncated: size > MAX_READ_BYTES,
		};
	} finally {
		await file.close();
	}
}

/** Whether the bytes read as text: no NUL bytes, as binary formats nearly always have. */
function looksLikeText(data) {
	return !data.subarray(0, 8192).includes(0);
}

function reasonFor(error) {
	if (error?.code === "ENOENT") return "It isn't there any more.";
	if (error?.code === "EACCES" || error?.code === "EPERM") return "The agent can't open it.";
	if (error?.code === "EISDIR") return "It's a folder.";
	if (error?.code === "ENOTDIR") return "It isn't a folder.";
	return "It couldn't be opened.";
}
