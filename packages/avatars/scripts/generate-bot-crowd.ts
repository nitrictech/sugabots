/**
 * Writes assets/bot-crowd.svg: a loose row of bot faces, as one standalone
 * file that image tools can convert to PNG or other formats.
 *
 * A standalone file cannot see Tailwind, so colours are resolved here from
 * Tailwind's palette and written as hex, which every SVG renderer supports.
 *
 * Run with `bun run --cwd packages/avatars generate:bot-crowd` after changing
 * the faces, the colours or the crowd below.
 */
import { writeFileSync } from "node:fs";
import { formatHex, parse, toGamut } from "culori";
import colors from "tailwindcss/colors";
import { BOT_EYES_SHADE, BOT_FACE_SHADE } from "../src/bot-colors.ts";
import type { BotLook } from "../src/bot-face.tsx";
import { FACE_VIEWBOX_SIZE, type FaceMark, faceMarks } from "../src/face-marks.ts";

/** Rendered size of one face, in pixels. */
const FACE_PX = 40;
const GAP_PX = 8;

/** A hand-placed crowd: degrees clockwise, and pixels lifted up. */
const crowd: readonly (BotLook & { rotate: number; lift: number })[] = [
	{ color: "rose", face: "dots", rotate: -8, lift: -4 },
	{ color: "yellow", face: "bar", rotate: 0, lift: 6 },
	{ color: "purple", face: "smile", rotate: 6, lift: 0 },
	{ color: "sky", face: "bar", rotate: -4, lift: 10 },
	{ color: "green", face: "square", rotate: 0, lift: -2 },
	{ color: "orange", face: "dots", rotate: 10, lift: 4 },
	{ color: "cyan", face: "smile", rotate: 0, lift: 8 },
	{ color: "teal", face: "dots", rotate: -6, lift: -3 },
];

// Tailwind v4 defines its palette in oklch; map it into sRGB through oklch.
const toSrgb = toGamut("rgb", "oklch");

function hex(tailwindColor: string): string {
	const parsed = parse(tailwindColor);
	if (!parsed) throw new Error(`Unparseable Tailwind colour: ${tailwindColor}`);
	return formatHex(toSrgb(parsed));
}

function markElement(mark: FaceMark, eyesHex: string): string {
	switch (mark.shape) {
		case "circle":
			return `<circle cx="${mark.cx}" cy="${mark.cy}" r="${mark.r}" fill="${eyesHex}"/>`;
		case "rect":
			return `<rect x="${mark.x}" y="${mark.y}" width="${mark.width}" height="${mark.height}" rx="${mark.rx}" fill="${eyesHex}"/>`;
		case "stroke":
			return `<path d="${mark.d}" fill="none" stroke="${eyesHex}" stroke-width="${mark.strokeWidth}" stroke-linecap="round"/>`;
	}
}

function faceElements({ color, face }: BotLook): string {
	const faceHex = hex(colors[color][BOT_FACE_SHADE]);
	const eyesHex = hex(colors[color][BOT_EYES_SHADE]);
	const radius = FACE_VIEWBOX_SIZE / 2;
	const disc = `<circle cx="${radius}" cy="${radius}" r="${radius}" fill="${faceHex}"/>`;
	return (
		disc +
		faceMarks(face)
			.map((mark) => markElement(mark, eyesHex))
			.join("")
	);
}

const maxLift = Math.max(...crowd.map((bot) => bot.lift));
const minLift = Math.min(...crowd.map((bot) => bot.lift));
// No padding: a face is a circle, so rotating it never grows its bounds.
const width = crowd.length * FACE_PX + (crowd.length - 1) * GAP_PX;
const height = FACE_PX + maxLift - minLift;
const scale = FACE_PX / FACE_VIEWBOX_SIZE;
const centre = FACE_PX / 2;

const faces = crowd.map((bot, index) => {
	const x = index * (FACE_PX + GAP_PX);
	const y = maxLift - bot.lift;
	return `<g transform="translate(${x} ${y}) rotate(${bot.rotate} ${centre} ${centre}) scale(${scale})">${faceElements(bot)}</g>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${faces.join("")}</svg>\n`;

const outputPath = new URL("../assets/bot-crowd.svg", import.meta.url);
writeFileSync(outputPath, svg);
console.log(`Wrote ${outputPath.pathname} (${width}×${height})`);
