import {
	type Frame,
	SLIDE_END_MARGIN,
	SLIDE_HEIGHT,
	SLIDE_WIDTH,
	SMALLEST_BOX_BY_HAND,
} from "@sugabots/contracts/slide-geometry";
import { SLIDE_SIDE_MARGINS, type SlideLayout } from "@sugabots/contracts/slide-layouts";

/*
 * Where a box on a slide goes when a person moves or resizes it by hand, in
 * a slide's pixels (see `Frame`): kept on the slide, or no further off it
 * than it was, as a picture that bleeds off an edge is; no smaller than a
 * person can still grab (`SMALLEST_BOX_BY_HAND`); and snapped to what it
 * comes close to lining up with.
 */

/** How near a moving edge or centre must come to a line to snap to it. */
const SNAP_DISTANCE_SLIDE_PX = 6;

/**
 * The corners and sides of a box it is resized by, in the order its outline
 * draws them, each named for the edges it moves: `top-left` moves the top and
 * left edges, and `top` the top alone.
 */
export const HANDLES = [
	"top-left",
	"top",
	"top-right",
	"right",
	"bottom-right",
	"bottom",
	"bottom-left",
	"left",
] as const;

export type Handle = (typeof HANDLES)[number];

export type Edge = "left" | "right" | "top" | "bottom";

/** Whether `handle` moves `edge` of its box: whether its name says `edge`. */
export const movesEdge = (handle: Handle, edge: Edge): boolean => handle.split("-").includes(edge);

/**
 * A line a box has snapped to, which is drawn across the slide while it
 * stays there: `down` the slide at `at` across it, or `across` the slide at
 * `at` down it.
 */
export interface Guide {
	direction: "down" | "across";
	at: number;
}

/** The lines a box snaps to: those running down the slide, by where they cross it, and those running across, by where they run down it. */
export interface SnapLines {
	down: readonly number[];
	across: readonly number[];
}

/** No lines at all, for a box moved by a key, which goes exactly as far as it says. */
export const NO_SNAP_LINES: SnapLines = { down: [], across: [] };

/** Where a box ends up, and the lines it snapped to on the way. */
export interface Arranged {
	frame: Frame;
	guides: Guide[];
}

/** How far a box, or the edges of it a handle moves, is moved across and down, in a slide's pixels. */
export interface Shift {
	dx: number;
	dy: number;
}

/**
 * The lines a box snaps to on a slide of `layout` holding `others`: the
 * layout's margins, the slide's centre lines, and the edges and centres of
 * the other boxes.
 */
export function snapLinesAround(others: readonly Frame[], layout: SlideLayout): SnapLines {
	const sideMargin = SLIDE_SIDE_MARGINS[layout];
	return {
		down: [
			sideMargin,
			SLIDE_WIDTH / 2,
			SLIDE_WIDTH - sideMargin,
			...others.flatMap(({ x, width }) => [x, x + width / 2, x + width]),
		],
		across: [
			SLIDE_END_MARGIN,
			SLIDE_HEIGHT / 2,
			SLIDE_HEIGHT - SLIDE_END_MARGIN,
			...others.flatMap(({ y, height }) => [y, y + height / 2, y + height]),
		],
	};
}

/** How far to shift the nearest of `points` onto the nearest of `lines` within snapping distance, and that line. */
function nearestSnap(points: readonly number[], lines: readonly number[]) {
	let best: { shift: number; at: number | undefined } = { shift: 0, at: undefined };
	let gap = SNAP_DISTANCE_SLIDE_PX;
	for (const point of points) {
		for (const line of lines) {
			if (Math.abs(line - point) > gap) continue;
			gap = Math.abs(line - point);
			best = { shift: line - point, at: line };
		}
	}
	return best;
}

const clamp = (value: number, least: number, most: number) =>
	Math.min(Math.max(value, least), most);

/**
 * Where a side of a box `size` long, which starts at `start` along a slide
 * `room` long, may start: on the slide, or, for a box already past an edge,
 * or longer than the slide, no further past it than it was.
 */
const startsWithin = (start: number, size: number, room: number) => ({
	least: Math.min(0, room - size, start),
	most: Math.max(0, room - size, start),
});

/**
 * `start` moved by `shift`, with its left edge, centre or right edge snapped
 * to the nearest line down the slide, and its top, middle or bottom to the
 * nearest across it, then kept on the slide, or no further off it than it
 * was. A line it no longer touches once kept so draws no guide.
 */
export function movedFrame(start: Frame, { dx, dy }: Shift, lines: SnapLines): Arranged {
	const { width, height } = start;
	const left = start.x + dx;
	const top = start.y + dy;
	const across = nearestSnap([left, left + width / 2, left + width], lines.down);
	const down = nearestSnap([top, top + height / 2, top + height], lines.across);
	const xRange = startsWithin(start.x, width, SLIDE_WIDTH);
	const yRange = startsWithin(start.y, height, SLIDE_HEIGHT);
	const x = Math.round(clamp(left + across.shift, xRange.least, xRange.most));
	const y = Math.round(clamp(top + down.shift, yRange.least, yRange.most));
	const guides: Guide[] = [];
	if (across.at !== undefined && touches([x, x + width / 2, x + width], across.at)) {
		guides.push({ direction: "down", at: across.at });
	}
	if (down.at !== undefined && touches([y, y + height / 2, y + height], down.at)) {
		guides.push({ direction: "across", at: down.at });
	}
	return { frame: { x, y, width, height }, guides };
}

/**
 * Whether one of `points` is on the line at `at`, give or take the half pixel
 * a frame's whole pixels can leave it from a line through another's centre.
 */
const touches = (points: readonly number[], at: number) =>
	points.some((point) => Math.abs(point - at) <= 0.5);

/**
 * `start` resized by dragging its `handle` by `shift`: each edge the handle
 * moves snapped to the nearest line it comes close to, and kept on the slide,
 * or no further off it than it was, and at least the smallest box from the
 * edge facing it. A box smaller than that already, as a deck can hold, is
 * kept at least as big as it is.
 */
export function resizedFrame(
	start: Frame,
	handle: Handle,
	{ dx, dy }: Shift,
	lines: SnapLines,
): Arranged {
	const leastWidth = Math.min(SMALLEST_BOX_BY_HAND.width, start.width);
	const leastHeight = Math.min(SMALLEST_BOX_BY_HAND.height, start.height);
	let [left, right] = [start.x, start.x + start.width];
	let [top, bottom] = [start.y, start.y + start.height];
	const guides: Guide[] = [];
	/** `edge` moved by `by`, snapped, and kept between `least` and `most`, with the guide for the line it snapped to. */
	const moveEdge = (
		edge: number,
		by: number,
		snapTo: readonly number[],
		least: number,
		most: number,
		direction: Guide["direction"],
	) => {
		const snap = nearestSnap([edge + by], snapTo);
		const moved = Math.round(clamp(edge + by + snap.shift, least, most));
		if (snap.at !== undefined && touches([moved], snap.at)) guides.push({ direction, at: snap.at });
		return moved;
	};
	if (movesEdge(handle, "left")) {
		left = moveEdge(left, dx, lines.down, Math.min(0, left), right - leastWidth, "down");
	}
	if (movesEdge(handle, "right")) {
		const most = Math.max(SLIDE_WIDTH, right);
		right = moveEdge(right, dx, lines.down, left + leastWidth, most, "down");
	}
	if (movesEdge(handle, "top")) {
		top = moveEdge(top, dy, lines.across, Math.min(0, top), bottom - leastHeight, "across");
	}
	if (movesEdge(handle, "bottom")) {
		const most = Math.max(SLIDE_HEIGHT, bottom);
		bottom = moveEdge(bottom, dy, lines.across, top + leastHeight, most, "across");
	}
	return { frame: { x: left, y: top, width: right - left, height: bottom - top }, guides };
}

export const sameFrame = (one: Frame, other: Frame) =>
	one.x === other.x &&
	one.y === other.y &&
	one.width === other.width &&
	one.height === other.height;
