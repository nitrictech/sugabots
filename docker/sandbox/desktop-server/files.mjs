// The desktop's files, for the web app's file browser: what is in a folder,
// and what a file holds, for a viewer in control, as the agents' user sees
// them, and files the viewer puts there. A viewer who only watches is told to
// take over, since a file browser reads whatever it's pointed at.
//
// From a viewer in control, as JSON text:
//   {type:"places"} | {type:"list", path} | {type:"read", path}
//   {type:"upload", id, folder, name, size}    then the file's bytes, in order:
//   {type:"upload-chunk", id, data:<base64>}   each answered with upload-received
// To the viewer:
//   {type:"places", places:[{kind:"thread"|"workspace"|"home"|"computer", path}]}
//   {type:"listing", path, entries:[{name, kind:"folder"|"file", size, modified}],
//    disk:{freeBytes, totalBytes}}    the disk the folder is on, if it can be told
//       again whenever the folder last listed changes, until a file is read
//   {type:"file", path, mediaType, data:<base64>, truncated}
//   {type:"refused", path, reason}
//   {type:"upload-received", id, bytes}        bytes received so far
//   {type:"uploaded", id, path} | {type:"upload-failed", id, reason}

import { watch } from "node:fs";
import { open, readdir, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { WebSocket } from "ws";

/** How much of a file is sent to be shown: enough for a long text file or a photo. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** How long a folder must stay unchanged before it's listed again, so a build writing many files sends one listing. */
const FOLDER_SETTLE_MS = 200;
const WORKSPACE = "/workspace";

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
	const watched = watchedFolder((path) => listing(path).then(send));
	const uploads = makeUploads(send);
	viewer.on("close", () => {
		watched.stop();
		uploads.abandon();
	});
	const answer = async (message) => {
		if (message?.type === "places") {
			return send({
				type: "places",
				places: [
					{ kind: "thread", path: folder },
					{ kind: "workspace", path: WORKSPACE },
					{ kind: "home", path: homedir() },
					{ kind: "computer", path: "/" },
				],
			});
		}
		if (message?.type === "upload") return uploads.start(message, folder);
		if (message?.type === "upload-chunk") return uploads.write(message);
		const path = resolve(folder, String(message?.path ?? "."));
		if (message?.type !== "list" && message?.type !== "read") return;
		try {
			if (message.type === "list") {
				const listed = await listing(path);
				watched.follow(listed.path);
				send(listed);
			} else {
				watched.stop();
				send(await contents(path));
			}
		} catch (error) {
			send({ type: "refused", path, reason: reasonFor(error) });
		}
	};

	// One at a time, so an upload's chunks are written in the order they came.
	let answering = Promise.resolve();
	viewer.on("message", (raw) => {
		let message;
		try {
			message = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (!mayUse) {
			const path = String(message?.path ?? folder);
			return send({ type: "refused", path, reason: "Take over to browse the files." });
		}
		answering = answering.then(() => answer(message)).catch(report);
	});
}

/** Watches one folder at a time, calling `changed` with its path once changes to it settle. */
function watchedFolder(changed) {
	let watcher;
	let settling;
	const stop = () => {
		clearTimeout(settling);
		watcher?.close();
		watcher = undefined;
	};
	return {
		follow(path) {
			stop();
			try {
				watcher = watch(path, { persistent: false }, () => {
					clearTimeout(settling);
					settling = setTimeout(() => changed(path).catch(report), FOLDER_SETTLE_MS);
				});
				watcher.on("error", stop);
			} catch {
				// A folder that can't be watched is still listed; it just isn't kept current.
			}
		},
		stop,
	};
}

/**
 * Files a viewer is putting in a folder. Each is written beside its folder
 * under a hidden name, and takes its own name, or a numbered one beside a
 * file of that name, only once all of it is there, so nothing in the sandbox
 * reads half a file or loses one it had.
 */
function makeUploads(send) {
	const uploads = new Map();

	const fail = async (id, error) => {
		const upload = uploads.get(id);
		uploads.delete(id);
		await upload?.file.close().catch(() => {});
		if (upload) await rm(upload.partPath, { force: true });
		send({ type: "upload-failed", id, reason: reasonFor(error) });
	};

	const finish = async (id) => {
		const upload = uploads.get(id);
		uploads.delete(id);
		await upload.file.close();
		const path = await freePath(upload.folder, upload.name);
		await rename(upload.partPath, path);
		send({ type: "uploaded", id, path });
	};

	return {
		async start({ id, folder: into, name, size }, folder) {
			const named = basename(String(name ?? ""));
			const bytes = Number(size);
			if (typeof id !== "string" || uploads.has(id)) return;
			if (!named || named === "." || named === ".." || named.includes("\0")) {
				return send({ type: "upload-failed", id, reason: "That name can't be used." });
			}
			if (!Number.isSafeInteger(bytes) || bytes < 0) {
				return send({ type: "upload-failed", id, reason: "It couldn't be uploaded." });
			}
			try {
				const target = await realpath(resolve(folder, String(into ?? ".")));
				const partPath = resolve(target, `.${named}.${process.pid}-${Date.now()}.part`);
				const file = await open(partPath, "wx");
				uploads.set(id, { folder: target, name: named, size: bytes, received: 0, file, partPath });
				send({ type: "upload-received", id, bytes: 0 });
				if (bytes === 0) await finish(id);
			} catch (error) {
				await fail(id, error);
			}
		},
		async write({ id, data }) {
			const upload = uploads.get(id);
			if (!upload) return;
			try {
				const chunk = Buffer.from(String(data ?? ""), "base64");
				if (upload.received + chunk.length > upload.size) throw new Error("longer than said");
				await upload.file.write(chunk);
				upload.received += chunk.length;
				send({ type: "upload-received", id, bytes: upload.received });
				if (upload.received === upload.size) await finish(id);
			} catch (error) {
				await fail(id, error);
			}
		},
		/** Removes what the viewer was still uploading when it left. */
		abandon() {
			for (const [id, upload] of uploads) {
				uploads.delete(id);
				void upload.file
					.close()
					.catch(() => {})
					.then(() => rm(upload.partPath, { force: true }))
					.catch(report);
			}
		},
	};
}

/** `name` in `folder`, or "name (2).ext" and so on if something there already has it. */
async function freePath(folder, name) {
	const extension = extname(name);
	const stem = name.slice(0, name.length - extension.length);
	for (let copy = 1; ; copy++) {
		const candidate = resolve(folder, copy === 1 ? name : `${stem} (${copy})${extension}`);
		const taken = await stat(candidate).then(
			() => true,
			() => false,
		);
		if (!taken) return candidate;
	}
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
	return { type: "listing", path: real, entries, disk: await diskOf(real) };
}

/** How much of the disk `path` is on the agents' user can still fill, and its size. */
async function diskOf(path) {
	try {
		const { bavail, blocks, bsize } = await statfs(path);
		return { freeBytes: bavail * bsize, totalBytes: blocks * bsize };
	} catch {
		return undefined;
	}
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
	if (error?.code === "ENOSPC") return "The sandbox's disk is full.";
	return "It couldn't be opened.";
}

function report(error) {
	console.error(error);
}

