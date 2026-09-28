/**
 * Writes the package's standalone SVGs, which image tools can convert to PNG
 * or other formats:
 *
 * - assets/bot-crowd.svg: the loose row of faces in src/bot-crowd.ts.
 * - assets/sugabots-logo.svg: the mark in src/sugabots-logo.ts.
 * - assets/sugabots-wordmark-light.svg and assets/sugabots-wordmark-dark.svg:
 *   the mark beside "Sugabots" in Rubik ExtraBold, as the website's header
 *   draws it, for light and dark backgrounds. The letters are outlined into
 *   paths because places like GitHub READMEs cannot load web fonts.
 *
 * The palette in src/bot-colors.ts is hex already, which every SVG renderer
 * supports, so it is written as it is.
 *
 * Run with `bun run --cwd packages/avatars generate:assets` after changing the
 * faces, the colours, the crowd or the logo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";
import { botColors } from "../src/bot-colors.ts";
import { botCrowd as crowd } from "../src/bot-crowd.ts";
import type { BotLook } from "../src/bot-face.tsx";
import { FACE_VIEWBOX_SIZE, type FaceMark, faceMarks } from "../src/face-marks.ts";
import { sugabotsLogo } from "../src/sugabots-logo.ts";

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
	const faceHex = botColors[color].face;
	const eyesHex = botColors[color].eyes;
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

function sugabotsLogoElements(): string {
	const dotPx = (LOGO_PX - LOGO_PADDING_PX * 2 - LOGO_GAP_PX) / 2;
	const radius = dotPx / 2;
	const centre = (cell: number) => LOGO_PADDING_PX + cell * (dotPx + LOGO_GAP_PX) + radius;
	const dots = sugabotsLogo.bots.map((color, index) => {
		const fill = botColors[color].face;
		return `<circle cx="${centre(index % 2)}" cy="${centre(Math.floor(index / 2))}" r="${radius}" fill="${fill}"/>`;
	});
	// The tint's eye colour: solid and dark, so the dots stand out on light and dark backgrounds.
	const tile = botColors[sugabotsLogo.tint].eyes;
	const background = `<rect width="${LOGO_PX}" height="${LOGO_PX}" rx="${LOGO_RADIUS_PX}" fill="${tile}"/>`;
	return background + dots.join("");
}

/*
 * The website header's lockup (a 32px mark, an 8px gap and 20px text) scaled
 * so the mark keeps its native 40px.
 */
const WORDMARK_SCALE = LOGO_PX / 32;
const WORDMARK_GAP_PX = 8 * WORDMARK_SCALE;
const WORDMARK_FONT_PX = 20 * WORDMARK_SCALE;
/** Tailwind's `tracking-tight`, in em. */
const WORDMARK_LETTER_SPACING_EM = -0.025;
/** The website's `--foreground`: zinc-900 on light backgrounds, zinc-100 on dark ones. */
const WORDMARK_TEXT_HEX = { light: "#18181b", dark: "#f4f4f5" };

/**
 * Outlines unshaped Latin text, applying the font's kerning and the wordmark's
 * letter spacing. opentype.js's own layout rejects one of Rubik's substitution
 * tables, and these letters need no substitutions.
 */
function latinTextPath(
	font: opentype.Font,
	text: string,
	x: number,
	baselineY: number,
): opentype.Path {
	const pxPerUnit = WORDMARK_FONT_PX / font.unitsPerEm;
	const letterSpacingPx = WORDMARK_LETTER_SPACING_EM * WORDMARK_FONT_PX;
	const glyphs = [...text].map((character) => font.charToGlyph(character));
	const path = new opentype.Path();
	let penX = x;
	glyphs.forEach((glyph, index) => {
		path.extend(glyph.getPath(penX, baselineY, WORDMARK_FONT_PX));
		const next = glyphs[index + 1];
		const kerningUnits = next ? font.getKerningValue(glyph, next) : 0;
		penX += ((glyph.advanceWidth ?? 0) + kerningUnits) * pxPerUnit + letterSpacingPx;
	});
	return path;
}

function writeSugabotsWordmark() {
	// opentype.js reads WOFF but not WOFF2.
	const fontPath = new URL(
		import.meta.resolve("@fontsource/rubik/files/rubik-latin-800-normal.woff"),
	);
	const fontFile = readFileSync(fontPath);
	const font = opentype.parse(
		fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength),
	);
	const text = "Sugabots";
	const pxPerUnit = WORDMARK_FONT_PX / font.unitsPerEm;
	// Centre the font's line box on the mark, as the header's flex row does.
	const lineHeightPx = (font.ascender - font.descender) * pxPerUnit;
	const baselineY = (LOGO_PX - lineHeightPx) / 2 + font.ascender * pxPerUnit;
	const textX = LOGO_PX + WORDMARK_GAP_PX;
	const path = latinTextPath(font, text, textX, baselineY);
	const width = Math.ceil(path.getBoundingBox().x2);
	const letters = path.toPathData(2);
	for (const [scheme, textHex] of Object.entries(WORDMARK_TEXT_HEX)) {
		const content = `${sugabotsLogoElements()}<path d="${letters}" fill="${textHex}"/>`;
		writeAsset(`sugabots-wordmark-${scheme}.svg`, width, LOGO_PX, content);
	}
}

writeBotCrowd();
writeAsset("sugabots-logo.svg", LOGO_PX, LOGO_PX, sugabotsLogoElements());
writeSugabotsWordmark();
