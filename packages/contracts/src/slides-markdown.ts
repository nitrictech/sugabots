/*
 * The markdown a `slides` deck is kept as, which bots read and write. Its
 * slides come one after another with a line of `---` between each two, a
 * blank line on either side of it. HTML comments say what markdown has no sign
 * for: a slide starts with its layout, as `<!-- layout: columns -->`; each of
 * its boxes after the first starts with `<!-- box -->`, the first being what
 * comes before; and the speaker's notes end the slide, as `<!-- notes: … -->`.
 * The editor's schema reads and writes these (see `live-slides.ts`).
 *
 * Where somebody placed a slide's boxes by hand, and which boxes they removed
 * from it, the markdown has no way to say. Both are people's alone, kept only
 * in the live document: a bot can neither read nor set them, and a deck read
 * from markdown has every box on its slide, where its layout puts it.
 */

/** How a slide is laid out, which says what its frame holds. */
export const SLIDE_LAYOUTS = [
	"title",
	"bullets",
	"columns",
	"image",
	"section",
	"quote",
	"table",
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const isSlideLayout = (value: unknown): value is SlideLayout =>
	(SLIDE_LAYOUTS as readonly unknown[]).includes(value);

/**
 * The boxes a slide of each layout holds, by what each is for, in the order
 * its frame holds them and its markdown writes them. A box's role is how the
 * app draws it, what it says while empty, and where a file the deck is saved
 * as puts it. In `image`, the image's box is where an image goes, which
 * nothing enforces; in `section`, the label, such as "Part 2", sits over the
 * title.
 */
export const SLIDE_BOX_ROLES = {
	title: ["title", "subtitle"],
	bullets: ["title", "body"],
	columns: ["title", "leftColumn", "rightColumn"],
	image: ["title", "text", "image"],
	section: ["label", "title"],
	quote: ["quote", "attribution"],
	table: ["title", "table"],
} as const satisfies Record<SlideLayout, readonly string[]>;

/** What a box on a slide is for, in its slide's layout. */
export type BoxRole = (typeof SLIDE_BOX_ROLES)[SlideLayout][number];

/** What goes between two slides, with a blank line on either side. */
export const SLIDE_SEPARATOR = "---";

/** The comment a slide starts with, saying its layout. */
export const layoutComment = (layout: SlideLayout) => `<!-- layout: ${layout} -->`;

/** The comment each box of a slide after its first starts with. */
export const BOX_COMMENT = "<!-- box -->";

/*
 * Where a slide's boxes are, when somebody placed them by hand rather than
 * leaving them to its layout. A slide is placed whole or not at all: a frame
 * for each of its boxes, or none, so a slide can't hold some boxes placed and
 * others its layout places.
 */

/**
 * A slide's size in the unit its boxes are placed in: a pixel of a slide
 * drawn 960 pixels wide, on which the unit the slide styles size everything
 * in is 16.
 */
export const SLIDE_WIDTH = 960;
export const SLIDE_HEIGHT = 540;

/**
 * The margin every layout keeps inside a slide at its top and at its foot, in
 * a slide's pixels: four units of the slide styles.
 */
export const SLIDE_END_MARGIN = 64;

/**
 * The least a box may be placed across or down, in a slide's pixels: one
 * unit of the slide styles, so a box can't be shrunk out of sight.
 */
const SMALLEST_FRAME = 16;

/** Where a box sits on its slide: its left, top, width and height, in a slide's whole pixels. */
export interface Frame {
	x: number;
	y: number;
	w: number;
	h: number;
}

declare const placementParsed: unique symbol;

/**
 * Where each of a slide's boxes sits, a frame for each, in the order the
 * slide holds its boxes. Only `placementIn` and `placementFromText` make one,
 * so one is always whole and within its slide.
 */
export type Placement = readonly Frame[] & { readonly [placementParsed]: true };

/**
 * `value` as the placement of a slide of `layout`: `null` unless it is a
 * frame for each of the layout's boxes, each in whole pixels, at least
 * `SMALLEST_FRAME` across and down, and within the slide. What a slide holds
 * comes from people's editors and from markdown bots write, so it is read
 * through this, never taken as it is.
 */
export function placementIn(value: unknown, layout: SlideLayout): Placement | null {
	if (!Array.isArray(value) || value.length !== SLIDE_BOX_ROLES[layout].length) return null;
	const frames: unknown[] = value;
	return frames.every(isFrame) ? (frames as unknown as Placement) : null;
}

function isFrame(value: unknown): value is Frame {
	if (typeof value !== "object" || value === null) return false;
	const { x, y, w, h } = value as Partial<Record<keyof Frame, unknown>>;
	return (
		isWhole(x) &&
		isWhole(y) &&
		isWhole(w) &&
		isWhole(h) &&
		x >= 0 &&
		y >= 0 &&
		w >= SMALLEST_FRAME &&
		h >= SMALLEST_FRAME &&
		x + w <= SLIDE_WIDTH &&
		y + h <= SLIDE_HEIGHT
	);
}

const isWhole = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * How far down a slide, in its pixels from its top, what the box at `box`
 * holds may reach before it is more than fits, on a slide whose boxes are at
 * `frames`, where `shown` says which of them are on it.
 *
 * What a box holds may run past the foot of its frame, and is drawn there, as
 * far as the top of the nearest box shown below it that it would run into:
 * one whose top is lower than its own and which shares some of its width. With
 * no such box, it may run as far as the margin every layout keeps at the
 * slide's foot (`SLIDE_END_MARGIN`). Its own frame is always its to fill,
 * though, so a frame set tall, or low on the slide, is usable in full.
 *
 * Throws a `RangeError` when `frames` holds no frame at `box`.
 */
export function roomBottom(
	frames: readonly Frame[],
	shown: readonly boolean[],
	box: number,
): number {
	const frame = frames[box];
	if (!frame) throw new RangeError(`A slide's frames hold no frame for box ${box}`);
	const topsBelow = frames
		.filter((other, index) => shown[index] && other.y > frame.y && shareWidth(other, frame))
		.map(({ y }) => y);
	const end = topsBelow.length > 0 ? Math.min(...topsBelow) : SLIDE_HEIGHT - SLIDE_END_MARGIN;
	return Math.max(frame.y + frame.h, end);
}

/** Whether `one` and `other` share some of a slide's width, so a line down the slide would cross both. */
const shareWidth = (one: Frame, other: Frame) =>
	one.x < other.x + other.w && other.x < one.x + one.w;

/**
 * A placement as a drawn slide says it (`data-placement`), which a slide
 * copied from the editor and pasted keeps: each frame's `x y w h`, a `;`
 * between each two.
 */
export const placementText = (placement: Placement) =>
	placement.map(({ x, y, w, h }) => `${x} ${y} ${w} ${h}`).join("; ");

/** The placement `text` says, as `placementText` writes one, for a slide of `layout`: `null` when it says none whole. */
export function placementFromText(text: string, layout: SlideLayout): Placement | null {
	const frames = text.split(";").map((frame) => {
		const [x, y, w, h, ...more] = frame.trim().split(/\s+/).map(wholeNumber);
		return more.length === 0 ? { x, y, w, h } : undefined;
	});
	return placementIn(frames, layout);
}

/** `written` as the whole number its digits say, or not a number when it is anything else, as a sign or a point. */
const wholeNumber = (written: string) => (/^\d+$/.test(written) ? Number(written) : Number.NaN);

/**
 * The comment holding a slide's notes, `markdown`: its paragraphs with a blank
 * line between each two. Words in markdown write `>` as `&gt;` already, but
 * code writes it as it is, and a `-->` would end the comment. So `-->` is
 * written `--\>`, and so that a `--\` already there isn't then read as one,
 * `--\` is written `--\\` first. `notesInComment` reads both back as they were.
 */
export const notesComment = (markdown: string) =>
	`<!-- notes: ${markdown.replaceAll("--\\", "--\\\\").replaceAll("-->", "--\\>")} -->`;

/** The notes `notesComment` wrote as `written`, as they were. */
const notesInComment = (written: string) =>
	written.replaceAll("--\\>", "-->").replaceAll("--\\\\", "--\\");

/** One of the comments a deck's markdown is written with. */
export type SlideComment =
	/** The layout as written, which may be none this version knows. */
	| { kind: "layout"; layout: string }
	| { kind: "box" }
	/** The notes' markdown: paragraphs with a blank line between each two. */
	| { kind: "notes"; markdown: string };

/**
 * The deck's comments `html` starts with, a piece of raw HTML in its
 * markdown, and what follows them: `undefined` when it starts with none. A
 * bot may write two on one line, or words after one, so all of them are read.
 */
export function readSlideComments(
	html: string,
): { comments: SlideComment[]; rest: string } | undefined {
	const comments: SlideComment[] = [];
	let rest = html;
	for (let match = COMMENT.exec(rest); match; match = COMMENT.exec(rest)) {
		const comment = slideComment(match[1] ?? "");
		if (!comment) break;
		comments.push(comment);
		rest = rest.slice(match[0].length);
	}
	return comments.length > 0 ? { comments, rest: rest.trim() } : undefined;
}

/** An HTML comment at the start of some text, with what it says. */
const COMMENT = /^\s*<!--([\s\S]*?)-->/;

/**
 * What a comment says, when it is one of a deck's: forgiving of case and a
 * missing colon. Decks written before slides held boxes started each of a
 * slide's two columns with `<!-- column -->`, and bots still may, or with
 * `<!-- columns -->`, so either starts a box.
 */
function slideComment(said: string): SlideComment | undefined {
	const [, keyword, value = ""] =
		/^\s*(layout|box|columns?|notes)\b\s*:?\s*([\s\S]*?)\s*$/i.exec(said) ?? [];
	switch (keyword?.toLowerCase()) {
		case "layout":
			return { kind: "layout", layout: value.toLowerCase() };
		case "box":
		case "column":
		case "columns":
			return { kind: "box" };
		case "notes":
			return { kind: "notes", markdown: notesInComment(value) };
		default:
			return undefined;
	}
}
