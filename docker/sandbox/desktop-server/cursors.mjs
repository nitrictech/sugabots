// The names of the desktop's pointers that apps give none. Chromium loads
// its pointers from the cursor theme as pictures, without their names, so a
// pointer with no name is looked up by its picture among the theme's.

import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

/** Where the desktop's cursor theme, Adwaita, keeps its pointers, each file named for one. */
const THEME_CURSORS = "/usr/share/icons/Adwaita/cursors";
/** Xcursor's file and picture markers: https://www.x.org/releases/current/doc/man/man3/Xcursor.3.xhtml */
const XCURSOR_MAGIC = "Xcur";
const XCURSOR_IMAGE = 0xfffd0002;

/**
 * The names of the theme's pointers, by `fingerprintOf` their pictures, at
 * every size. Each is named for the file it's kept in, whose name CSS's
 * cursors share; X's older names for them are links to those files.
 */
export async function themePointers() {
	const files = new Set();
	for (const name of await readdir(THEME_CURSORS)) {
		const file = await realpath(join(THEME_CURSORS, name)).catch(() => undefined);
		if (file) files.add(file);
	}
	const named = new Map();
	for (const file of files) {
		for (const image of imagesIn(await readFile(file))) {
			named.set(fingerprintOf(image), basename(file));
		}
	}
	return named;
}

/** What tells one pointer picture from another: its size, hot spot and pixels. */
export function fingerprintOf({ width, height, hotX, hotY, pixels }) {
	return createHash("sha1")
		.update(`${width}x${height}@${hotX},${hotY}:`)
		.update(pixels)
		.digest("hex");
}

/** The pictures in an Xcursor file, each `{width, height, hotX, hotY, pixels}`, pixels as ARGB words. */
function imagesIn(file) {
	if (file.toString("latin1", 0, 4) !== XCURSOR_MAGIC) return [];
	const headerSize = file.readUInt32LE(4);
	const entries = file.readUInt32LE(12);
	const images = [];
	for (let entry = 0; entry < entries; entry++) {
		const at = headerSize + entry * 12;
		if (file.readUInt32LE(at) !== XCURSOR_IMAGE) continue;
		const chunk = file.readUInt32LE(at + 8);
		const width = file.readUInt32LE(chunk + 16);
		const height = file.readUInt32LE(chunk + 20);
		const start = chunk + file.readUInt32LE(chunk);
		images.push({
			width,
			height,
			hotX: file.readUInt32LE(chunk + 24),
			hotY: file.readUInt32LE(chunk + 28),
			pixels: file.subarray(start, start + width * height * 4),
		});
	}
	return images;
}
