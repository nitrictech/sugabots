/*
 * A slide's size, and where a box sits on it, in a slide's pixels: the
 * pixels of the slide drawn `SLIDE_WIDTH` wide. Every length a deck stores is
 * in them, frames, padding, strokes and text sizes alike, so whatever draws a
 * slide at another size scales all of them together.
 */

/** The unit the slide styles size text and spacing in, a 60th of a slide's width, in a slide's pixels. */
export const SLIDE_UNIT = 16;

/** A slide's size in its pixels: 60 units across and 33.75 down, 16:9. */
export const SLIDE_WIDTH = 60 * SLIDE_UNIT;
export const SLIDE_HEIGHT = 33.75 * SLIDE_UNIT;

/** The margin the layouts keep inside a slide at its top and at its foot, in a slide's pixels. */
export const SLIDE_END_MARGIN = 4 * SLIDE_UNIT;

/** The margin most layouts keep inside a slide at its left and at its right, in a slide's pixels (see `SLIDE_SIDE_MARGINS`). */
export const SLIDE_SIDE_MARGIN = 5 * SLIDE_UNIT;

/**
 * The least a person may make a box across and down by hand, in a slide's
 * pixels: room for a short word of the smallest text. A box made any other
 * way, as a line imported from a file, may be smaller.
 */
export const SMALLEST_BOX_BY_HAND = { width: 3 * SLIDE_UNIT, height: 1.5 * SLIDE_UNIT } as const;

/**
 * Where a box sits on its slide: its left, top, width and height, in a
 * slide's pixels. It may reach past the slide's edges, as a picture that
 * bleeds off one does, and may be no wider or taller than a line.
 */
export interface Frame {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * `value` as a frame: `undefined` unless it holds a finite left, top, width
 * and height, its width and height not below 0. A stored frame comes from
 * people's editors, files and bots, so it is read through this.
 */
export function frameIn(value: unknown): Frame | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { x, y, width, height } = value as Partial<Record<keyof Frame, unknown>>;
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined;
	if (!isFiniteNumber(width) || !isFiniteNumber(height) || width < 0 || height < 0) {
		return undefined;
	}
	return { x, y, width, height };
}

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/**
 * The frame of a box nothing places, as one a bot writes without saying
 * where: the slide within the margins most layouts keep.
 */
export const DEFAULT_BOX_FRAME: Frame = Object.freeze({
	x: SLIDE_SIDE_MARGIN,
	y: SLIDE_END_MARGIN,
	width: SLIDE_WIDTH - 2 * SLIDE_SIDE_MARGIN,
	height: SLIDE_HEIGHT - 2 * SLIDE_END_MARGIN,
});

/**
 * How far down a slide, in its pixels from its top, what the box framed at
 * `frames[box]` holds may reach before it is more than fits, on a slide whose
 * boxes are at `frames`.
 *
 * What a box holds may run past the foot of its frame, and is drawn there, as
 * far as the top of the nearest box below it that it would run into: one
 * whose top is lower than its own and which shares some of its width. With no
 * such box, it may run as far as the margin the layouts keep at the slide's
 * foot (`SLIDE_END_MARGIN`). Its own frame is always its to fill, though, so a
 * frame set tall, or low on the slide, is usable in full.
 *
 * Throws a `RangeError` when `frames` holds no frame at `box`.
 */
export function roomBottom(frames: readonly Frame[], box: number): number {
	const frame = frames[box];
	if (!frame) throw new RangeError(`A slide's frames hold no frame for box ${box}`);
	const topsBelow = frames
		.filter((other) => other.y > frame.y && shareWidth(other, frame))
		.map(({ y }) => y);
	const end = topsBelow.length > 0 ? Math.min(...topsBelow) : SLIDE_HEIGHT - SLIDE_END_MARGIN;
	return Math.max(frame.y + frame.height, end);
}

/** Whether `one` and `other` share some of a slide's width, so a line down the slide would cross both. */
const shareWidth = (one: Frame, other: Frame) =>
	one.x < other.x + other.width && other.x < one.x + one.width;
