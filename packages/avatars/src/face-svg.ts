import { botColors } from "./bot-colors.ts";
import type { BotLook } from "./bot-look.ts";
import { FACE_VIEWBOX_SIZE, type FaceMark, faceMarks } from "./face-marks.ts";
import { type HeadPart, headShape } from "./head-shapes.ts";

/**
 * A bot's face as SVG markup, for files and places React doesn't render:
 * its head and eyes in the 40-unit square `BotFace` draws in.
 */
export function botFaceSvg({ color, face, shape = "circle" }: BotLook): string {
	const faceHex = botColors[color].face;
	const eyesHex = botColors[color].eyes;
	const head = headShape(shape);
	const centre = FACE_VIEWBOX_SIZE / 2;
	const { x, y, scale } = head.eyes;
	const parts = head.parts.map((part) => partElement(part, faceHex)).join("");
	const marks = faceMarks(face)
		.map((mark) => markElement(mark, eyesHex))
		.join("");
	// Eyes where a circle has them need no moving, which keeps a circle's markup as it was before shapes.
	const centred = x === centre && y === centre && scale === 1;
	return centred
		? parts + marks
		: `${parts}<g transform="translate(${x} ${y}) scale(${scale}) translate(${-centre} ${-centre})">${marks}</g>`;
}

/** A bot's face drawn at `size` pixels with its top-left corner at (x, y), turned `rotate` degrees about its centre. */
export function placedBotFaceSvg(look: BotLook, x: number, y: number, size: number, rotate = 0) {
	const centre = size / 2;
	const scale = size / FACE_VIEWBOX_SIZE;
	return `<g transform="translate(${x} ${y}) rotate(${rotate} ${centre} ${centre}) scale(${scale})">${botFaceSvg(look)}</g>`;
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

function partElement(part: HeadPart, fill: string): string {
	return part.kind === "circle"
		? `<circle cx="${part.cx}" cy="${part.cy}" r="${part.r}" fill="${fill}"/>`
		: `<path d="${part.d}" fill="${fill}"/>`;
}
