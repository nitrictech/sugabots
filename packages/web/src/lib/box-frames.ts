import {
	type Frame,
	SLIDE_END_MARGIN,
	SLIDE_HEIGHT,
	SLIDE_WIDTH,
} from "@sugabots/contracts/slides-markdown";

/*
 * Where a box on a slide goes when a person moves or resizes it by hand, in
 * a slide's pixels (see `Frame`): kept on the slide, no smaller than a person
 * can still grab, and snapped to what it comes close to lining up with.
 */

/** The least a person can make a box across and down: room for a short word of the smallest text. */
export const SMALLEST_BOX_WIDTH = 48;
export const SMALLEST_BOX_HEIGHT = 24;

/**
 * The margin every layout keeps inside a slide from its left and right edges,
 * as `SLIDE_END_MARGIN` is the one from its top and foot.
 */
const SIDE_MARGIN = 80;

/**
 * Where a box removed from a slide its layout places is put when somebody
 * places the slide's other boxes by hand, as it isn't drawn to be measured:
 * across the slide within the margins every layout keeps, so whatever is put
 * in it later, as by a bot writing in it, shows in full until it is moved.
 */
export const REMOVED_BOX_FRAME: Frame = {
	x: SIDE_MARGIN,
	y: SLIDE_END_MARGIN,
	w: SLIDE_WIDTH - 2 * SIDE_MARGIN,
	h: SLIDE_HEIGHT - 2 * SLIDE_END_MARGIN,
};

/** How near a moving edge or centre must come to a line, in a slide's pixels, to snap to it. */
const SNAP_DISTANCE = 6;

/** A corner or side of a box, by which it is resized. */
export type Handle =
	| "top-left"
	| "top"
	| "top-right"
	| "right"
	| "bottom-right"
	| "bottom"
	| "bottom-left"
	| "left";

export const HANDLES: readonly Handle[] = [
	"top-left",
	"top",
	"top-right",
	"right",
	"bottom-right",
	"bottom",
	"bottom-left",
	"left",
];

/** The edges of a box each handle moves. */
const HANDLE_EDGES: Record<Handle, { left?: true; right?: true; top?: true; bottom?: true }> = {
	"top-left": { top: true, left: true },
	top: { top: true },
	"top-right": { top: true, right: true },
	right: { right: true },
	"bottom-right": { bottom: true, right: true },
	bottom: { bottom: true },
	"bottom-left": { bottom: true, left: true },
	left: { left: true },
};

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

/** How far the pointer has moved, in a slide's pixels. */
export interface Shift {
	dx: number;
	dy: number;
}

/**
 * The lines a box snaps to on a slide holding `others`: the slide's margins
 * and centre lines, and the edges and centres of the other boxes.
 */
export function snapLinesAround(others: readonly Frame[]): SnapLines {
	return {
		down: [
			SIDE_MARGIN,
			SLIDE_WIDTH / 2,
			SLIDE_WIDTH - SIDE_MARGIN,
			...others.flatMap(({ x, w }) => [x, x + w / 2, x + w]),
		],
		across: [
			SLIDE_END_MARGIN,
			SLIDE_HEIGHT / 2,
			SLIDE_HEIGHT - SLIDE_END_MARGIN,
			...others.flatMap(({ y, h }) => [y, y + h / 2, y + h]),
		],
	};
}

/** How far to shift the nearest of `points` onto the nearest of `lines` within snapping distance, and that line. */
function nearestSnap(points: readonly number[], lines: readonly number[]) {
	let best: { shift: number; at: number | undefined } = { shift: 0, at: undefined };
	let gap = SNAP_DISTANCE;
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
 * `start` moved by `shift`, with its left edge, centre or right edge snapped
 * to the nearest line down the slide, and its top, middle or bottom to the
 * nearest across it, then kept on the slide. A line it no longer touches once
 * kept on the slide draws no guide.
 */
export function movedFrame(start: Frame, { dx, dy }: Shift, lines: SnapLines): Arranged {
	const left = start.x + dx;
	const top = start.y + dy;
	const across = nearestSnap([left, left + start.w / 2, left + start.w], lines.down);
	const down = nearestSnap([top, top + start.h / 2, top + start.h], lines.across);
	const x = Math.round(clamp(left + across.shift, 0, SLIDE_WIDTH - start.w));
	const y = Math.round(clamp(top + down.shift, 0, SLIDE_HEIGHT - start.h));
	const guides: Guide[] = [];
	if (across.at !== undefined && touches([x, x + start.w / 2, x + start.w], across.at)) {
		guides.push({ direction: "down", at: across.at });
	}
	if (down.at !== undefined && touches([y, y + start.h / 2, y + start.h], down.at)) {
		guides.push({ direction: "across", at: down.at });
	}
	return { frame: { x, y, w: start.w, h: start.h }, guides };
}

/**
 * Whether one of `points` is on the line at `at`, give or take the half pixel
 * a frame's whole pixels can leave it from a line through another's centre.
 */
const touches = (points: readonly number[], at: number) =>
	points.some((point) => Math.abs(point - at) <= 0.5);

/**
 * `start` resized by dragging its `handle` by `shift`: each edge the handle
 * moves snapped to the nearest line it comes close to, and kept on the slide
 * and at least the smallest box from the edge facing it. A box smaller than
 * that already, as a deck can hold, is kept at least as big as it is.
 */
export function resizedFrame(
	start: Frame,
	handle: Handle,
	{ dx, dy }: Shift,
	lines: SnapLines,
): Arranged {
	const edges = HANDLE_EDGES[handle];
	const leastWidth = Math.min(SMALLEST_BOX_WIDTH, start.w);
	const leastHeight = Math.min(SMALLEST_BOX_HEIGHT, start.h);
	let [left, right] = [start.x, start.x + start.w];
	let [top, bottom] = [start.y, start.y + start.h];
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
	if (edges.left) left = moveEdge(left, dx, lines.down, 0, right - leastWidth, "down");
	if (edges.right) right = moveEdge(right, dx, lines.down, left + leastWidth, SLIDE_WIDTH, "down");
	if (edges.top) top = moveEdge(top, dy, lines.across, 0, bottom - leastHeight, "across");
	if (edges.bottom) {
		bottom = moveEdge(bottom, dy, lines.across, top + leastHeight, SLIDE_HEIGHT, "across");
	}
	return { frame: { x: left, y: top, w: right - left, h: bottom - top }, guides };
}

export const sameFrame = (one: Frame, other: Frame) =>
	one.x === other.x && one.y === other.y && one.w === other.w && one.h === other.h;

/** The window's pixels a box or slide is drawn at, as `getBoundingClientRect` gives them. */
interface DrawnRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * The frame of a box drawn at `box` on a slide drawn at `slide`: where it is
 * drawn, in the slide's whole pixels, no smaller than the smallest box, and
 * cut at the slide's edges where it runs past them. Its size is rounded up,
 * so what the box holds still fits it once it is drawn at its frame.
 */
export function frameOfDrawnBox(box: DrawnRect, slide: Omit<DrawnRect, "height">): Frame {
	const scale = slide.width / SLIDE_WIDTH;
	const x = clamp(Math.round((box.left - slide.left) / scale), 0, SLIDE_WIDTH - SMALLEST_BOX_WIDTH);
	const y = clamp(Math.round((box.top - slide.top) / scale), 0, SLIDE_HEIGHT - SMALLEST_BOX_HEIGHT);
	const w = clamp(Math.ceil(box.width / scale), SMALLEST_BOX_WIDTH, SLIDE_WIDTH - x);
	const h = clamp(Math.ceil(box.height / scale), SMALLEST_BOX_HEIGHT, SLIDE_HEIGHT - y);
	return { x, y, w, h };
}
