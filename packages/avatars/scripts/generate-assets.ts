/**
 * Writes the package's standalone SVGs, which image tools can convert to PNG
 * or other formats:
 *
 * - assets/bot-crowd.svg: the loose row of faces in src/bot-crowd.ts.
 * - assets/sugabots-logo.svg: the mark in src/sugabots-logo.ts.
 *
 * A standalone file cannot see Tailwind, so colours are resolved here from
 * Tailwind's palette and written as hex, which every SVG renderer supports.
 *
 * Run with `bun run --cwd packages/avatars generate:assets` after changing the
 * faces, the colours, the crowd or the logo.
 */
import { writeFileSync } from "node:fs";
import { formatHex, parse, toGamut } from "culori";
import colors from "tailwindcss/colors";
import { BOT_EYES_SHADE, BOT_FACE_SHADE } from "../src/bot-colors.ts";
import { botCrowd as crowd } from "../src/bot-crowd.ts";
import type { BotLook } from "../src/bot-face.tsx";
import { FACE_VIEWBOX_SIZE, type FaceMark, faceMarks } from "../src/face-marks.ts";
import { sugabotsLogo } from "../src/sugabots-logo.ts";

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

function writeAsset(name: string, width: number, height: number, content: string) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>\n`;
	const outputPath = new URL(`../assets/${name}`, import.meta.url);
	writeFileSync(outputPath, svg);
	console.log(`Wrote ${outputPath.pathname} (${width}×${height})`);
}

/** A face drawn at `size` pixels with its top-left corner at (x, y). */
function placedFace(bot: BotLook, x: number, y: number, size: number, rotate = 0): string {
	const centre = size / 2;
	const scale = size / FACE_VIEWBOX_SIZE;
	return `<g transform="translate(${x} ${y}) rotate(${rotate} ${centre} ${centre}) scale(${scale})">${faceElements(bot)}</g>`;
}

function writeBotCrowd() {
	/** One face, in pixels; the crowd's lifts are measured at this size. */
	const facePx = 40;
	const gapPx = 8;
	const maxLift = Math.max(...crowd.map((bot) => bot.lift));
	const minLift = Math.min(...crowd.map((bot) => bot.lift));
	// No padding: a face is a circle, so rotating it never grows its bounds.
	const width = crowd.length * facePx + (crowd.length - 1) * gapPx;
	const height = facePx + maxLift - minLift;
	const faces = crowd.map((bot, index) =>
		placedFace(bot, index * (facePx + gapPx), maxLift - bot.lift, facePx, bot.rotate),
	);
	writeAsset("bot-crowd.svg", width, height, faces.join(""));
}

/* A 40px rounded tile with 6px of padding and a 2px gap around a 2×2 grid of 13px dots. */
const LOGO_PX = 40;
const LOGO_RADIUS_PX = 14;
const LOGO_PADDING_PX = 6;
const LOGO_GAP_PX = 2;
/** Solid and dark, so the dots stand out on light and dark backgrounds. */
const LOGO_TILE_SHADE = 950;

function writeSugabotsLogo() {
	const dotPx = (LOGO_PX - LOGO_PADDING_PX * 2 - LOGO_GAP_PX) / 2;
	const radius = dotPx / 2;
	const centre = (cell: number) => LOGO_PADDING_PX + cell * (dotPx + LOGO_GAP_PX) + radius;
	const dots = sugabotsLogo.bots.map((color, index) => {
		const fill = hex(colors[color][BOT_FACE_SHADE]);
		return `<circle cx="${centre(index % 2)}" cy="${centre(Math.floor(index / 2))}" r="${radius}" fill="${fill}"/>`;
	});
	const tile = hex(colors[sugabotsLogo.tint][LOGO_TILE_SHADE]);
	const background = `<rect width="${LOGO_PX}" height="${LOGO_PX}" rx="${LOGO_RADIUS_PX}" fill="${tile}"/>`;
	writeAsset("sugabots-logo.svg", LOGO_PX, LOGO_PX, background + dots.join(""));
}

writeBotCrowd();
writeSugabotsLogo();
