import type { AgentFace } from "@sugabots/contracts";

/** The side of the square a face is drawn in, in SVG user units. */
export const FACE_VIEWBOX_SIZE = 40;

/** A distance in viewbox units as a number of percent of the face, for placing or moving an HTML layer the face's size. */
export function viewboxPercentage(units: number): number {
	return (units / FACE_VIEWBOX_SIZE) * 100;
}

/** The size of each of a thinking bot's dots, on the 40-unit face. */
export const THINKING_DOT_RADIUS = 2.4;

/** How thick an arc eye's line is; a shut or smiling eye is drawn as thick. */
export const ARC_EYE_STROKE_WIDTH = 1.8;

/**
 * How far an arc eye rises as it shuts: its arcs stand on a line about two
 * units below where open eyes are centred.
 */
export const ARC_SHUT_RISE = 2;

/** The flattest an arc eye's arc is drawn, so it never becomes a straight line its path can't bend. */
export const FLATTEST_ARC_HEIGHT = 0.01;

/**
 * The smile arc an open eye closes into is the top half of a ring
 * `SMILE_ARC_WIDENING` wider on each side than the eye, standing
 * `SMILE_ARC_BASELINE_SHARE` of its radius below the eye's centre.
 */
export const SMILE_ARC_WIDENING = 0.6;
export const SMILE_ARC_BASELINE_SHARE = 0.4;

/**
 * As the bot's smile grows from 0 to 1, an open eye fades out over
 * `OPEN_EYE_FADES` of it, and the smile arc fades in over `SMILE_ARC_SHOWS`.
 */
export const OPEN_EYE_FADES = [0, 0.5] as const;
export const SMILE_ARC_SHOWS = [0, 0.3] as const;

/*
 * A thinking bot's three dots, across where its eyes were: their centres'
 * x, left to right, and their y.
 */
export const THINKING_DOT_XS = [14, 20, 26] as const;
export const THINKING_DOT_Y = 20;

/** One mark drawn on the face disc: an eye, or both eyes as one stroked path. */
export type FaceMark =
	| { shape: "circle"; cx: number; cy: number; r: number }
	| { shape: "rect"; x: number; y: number; width: number; height: number; rx: number }
	| { shape: "stroke"; d: string; strokeWidth: number };

/*
 * The design sizes each eye as a fraction of the face's diameter and centres
 * the pair; these are those fractions on a 40-unit face. An arc is the top
 * half of a ring, drawn along its centre line.
 */
const marksByFace: Record<AgentFace, readonly FaceMark[]> = {
	// 0.125 × 0.25 bars, 0.17 apart.
	pill: [
		{ shape: "rect", x: 11.6, y: 15, width: 5, height: 10, rx: 2.8 },
		{ shape: "rect", x: 23.4, y: 15, width: 5, height: 10, rx: 2.8 },
	],
	// 0.14 dots, 0.15 apart.
	dot: [
		{ shape: "circle", cx: 14.2, cy: 20, r: 2.8 },
		{ shape: "circle", cx: 25.8, cy: 20, r: 2.8 },
	],
	// 0.2-wide arcs with a 0.045 stroke, 0.1 apart.
	arc: [
		{
			shape: "stroke",
			d: "M10.9 22a3.1 3.1 0 0 1 6.2 0M22.9 22a3.1 3.1 0 0 1 6.2 0",
			strokeWidth: ARC_EYE_STROKE_WIDTH,
		},
	],
	// 0.16 squares, 0.12 apart.
	square: [
		{ shape: "rect", x: 11.2, y: 16.8, width: 6.4, height: 6.4, rx: 1.8 },
		{ shape: "rect", x: 22.4, y: 16.8, width: 6.4, height: 6.4, rx: 1.8 },
	],
	// A 0.14 dot and a 0.19-wide arc, 0.13 apart.
	wink: [
		{ shape: "circle", cx: 13.6, cy: 20, r: 2.8 },
		{ shape: "stroke", d: "M22.5 22.4a2.9 2.9 0 0 1 5.8 0", strokeWidth: ARC_EYE_STROKE_WIDTH },
	],
};

/** The marks that make up a face, on a disc filling the viewbox. */
export function faceMarks(face: AgentFace): readonly FaceMark[] {
	return marksByFace[face];
}
