import type { BoxRole, VerticalAlign } from "./slide-box.ts";
import {
	DEFAULT_BOX_FRAME,
	type Frame,
	SLIDE_END_MARGIN,
	SLIDE_HEIGHT,
	SLIDE_SIDE_MARGIN,
	SLIDE_UNIT,
	SLIDE_WIDTH,
} from "./slide-geometry.ts";

/*
 * The layouts a slide is made from. Each is a template: the boxes a new
 * slide of it holds, what each is for, and where each goes. A slide keeps the
 * layout it was last laid out by, which says where its role boxes go back to
 * (see `laidOutAnew` and `resetToTemplate` in `live-slides.ts`), but nothing
 * holds a slide to it: people and bots move, add and delete its boxes freely.
 *
 * The frames are those the layouts' styles drew their boxes at, for a title
 * of a line, in the app's slide styles: text of 1.5 units at a line height of
 * 1.4, headings of 2.5 units at 1.15, blocks 2 units apart.
 */

export const SLIDE_LAYOUTS = [
	"title",
	"bullets",
	"columns",
	"image",
	"section",
	"quote",
	"table",
	"blank",
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const isSlideLayout = (value: unknown): value is SlideLayout =>
	(SLIDE_LAYOUTS as readonly unknown[]).includes(value);

/** `value` as a slide's layout, or `blank`, which places nothing, when it is none this version knows. */
export const slideLayoutIn = (value: unknown): SlideLayout =>
	isSlideLayout(value) ? value : "blank";

/** The margin each layout keeps inside a slide at its left and at its right, in a slide's pixels: wider for a quote. */
export const SLIDE_SIDE_MARGINS: Readonly<Record<SlideLayout, number>> = {
	title: SLIDE_SIDE_MARGIN,
	bullets: SLIDE_SIDE_MARGIN,
	columns: SLIDE_SIDE_MARGIN,
	image: SLIDE_SIDE_MARGIN,
	section: SLIDE_SIDE_MARGIN,
	quote: 7 * SLIDE_UNIT,
	table: SLIDE_SIDE_MARGIN,
	blank: SLIDE_SIDE_MARGIN,
};

/** One of the boxes a layout places: what it is for, its frame, and where what it holds sits in that. */
export interface TemplateBox {
	readonly role: BoxRole;
	readonly frame: Frame;
	readonly verticalAlign: VerticalAlign;
}

const placed = <R extends BoxRole>(role: R, frame: Frame, verticalAlign: VerticalAlign = "top") =>
	({ role, frame, verticalAlign }) as const;

const CONTENT_WIDTH = SLIDE_WIDTH - 2 * SLIDE_SIDE_MARGIN;
const CONTENT_BOTTOM = SLIDE_HEIGHT - SLIDE_END_MARGIN;

/** A title across a slide's top: one line of its heading, rounded up to whole units. */
const TOP_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: SLIDE_END_MARGIN,
	width: CONTENT_WIDTH,
	height: 3 * SLIDE_UNIT,
};

/** Where what goes under a title across the top starts: 2 units, the space between blocks, below it. */
const UNDER_TITLE = TOP_TITLE.y + TOP_TITLE.height + 2 * SLIDE_UNIT;

/** What goes under a title across the top, down to the margin at the slide's foot. */
const UNDER_TOP_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: UNDER_TITLE,
	width: CONTENT_WIDTH,
	height: CONTENT_BOTTOM - UNDER_TITLE,
};

const COLUMN_GAP = 3.5 * SLIDE_UNIT;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;
const RIGHT_COLUMN = SLIDE_SIDE_MARGIN + COLUMN_WIDTH + COLUMN_GAP;

const QUOTE_MARGIN = SLIDE_SIDE_MARGINS.quote;
const QUOTE_WIDTH = SLIDE_WIDTH - 2 * QUOTE_MARGIN;

/**
 * The boxes each layout places, in the order a new slide of it holds them,
 * which is the order they are drawn in, each over the one before. Where a
 * layout set its boxes in the slide's middle or at its foot, the boxes that
 * may grow as they fill sit with what they hold at the edge the others are
 * on, so a title of more lines grows away from its subtitle, not into it.
 */
export const SLIDE_TEMPLATES = {
	/** A large title, and a subtitle under it, in the middle: a line of each straddles the slide's middle. */
	title: [
		placed("title", { x: SLIDE_SIDE_MARGIN, y: 100, width: CONTENT_WIDTH, height: 176 }, "bottom"),
		placed("subtitle", { x: SLIDE_SIDE_MARGIN, y: 296, width: CONTENT_WIDTH, height: 116 }),
	],
	bullets: [placed("title", TOP_TITLE), placed("body", UNDER_TOP_TITLE)],
	/** The title across the top, and two columns side by side under it. */
	columns: [
		placed("title", TOP_TITLE),
		placed("leftColumn", { ...UNDER_TOP_TITLE, width: COLUMN_WIDTH }),
		placed("rightColumn", { ...UNDER_TOP_TITLE, x: RIGHT_COLUMN, width: COLUMN_WIDTH }),
	],
	/** The title over its text, together in the middle of the left, and the image filling the right. */
	image: [
		placed("title", { x: SLIDE_SIDE_MARGIN, y: 112, width: COLUMN_WIDTH, height: 104 }, "bottom"),
		placed("text", { x: SLIDE_SIDE_MARGIN, y: 236, width: COLUMN_WIDTH, height: 176 }),
		placed(
			"image",
			{
				x: RIGHT_COLUMN,
				y: SLIDE_END_MARGIN,
				width: COLUMN_WIDTH,
				height: CONTENT_BOTTOM - SLIDE_END_MARGIN,
			},
			"middle",
		),
	],
	/** A label, such as "Part 2", over a very large title, at the slide's foot. */
	section: [
		placed("label", { x: SLIDE_SIDE_MARGIN, y: 360, width: CONTENT_WIDTH, height: 28 }, "bottom"),
		placed("title", { x: SLIDE_SIDE_MARGIN, y: 404, width: CONTENT_WIDTH, height: 72 }, "bottom"),
	],
	/** The quote large, and who said it under it, in the middle, within wider margins. */
	quote: [
		placed("quote", { x: QUOTE_MARGIN, y: 96, width: QUOTE_WIDTH, height: 216 }, "bottom"),
		placed("attribution", { x: QUOTE_MARGIN, y: 340, width: QUOTE_WIDTH, height: 72 }),
	],
	table: [placed("title", TOP_TITLE), placed("table", UNDER_TOP_TITLE)],
	/** Nothing, for a slide whose boxes go wherever they are put, as one imported from a file. */
	blank: [],
} as const satisfies Record<SlideLayout, readonly TemplateBox[]>;

/** The roles of the boxes a slide of `L`'s template places. */
export type TemplateRoleOf<L extends SlideLayout> = (typeof SLIDE_TEMPLATES)[L][number]["role"];

/** The box of `role` that `layout`'s template places, if it places one. */
export const templateBoxOf = (layout: SlideLayout, role: BoxRole): TemplateBox | undefined =>
	(SLIDE_TEMPLATES[layout] as readonly TemplateBox[]).find((box) => box.role === role);

/** A layout whose template places a box of `R`. */
type LayoutPlacing<R extends BoxRole> = {
	[L in SlideLayout]: R extends TemplateRoleOf<L> ? L : never;
}[SlideLayout];

/**
 * The layout whose frame a box of each role takes when its own slide's
 * layout places no box of that role, as a title a bot writes on a blank slide
 * without saying where: the layout such a box is most at home in.
 */
const ROLE_HOMES: { readonly [R in BoxRole]: LayoutPlacing<R> } = {
	title: "bullets",
	subtitle: "title",
	body: "bullets",
	leftColumn: "columns",
	rightColumn: "columns",
	text: "image",
	image: "image",
	label: "section",
	quote: "quote",
	attribution: "quote",
	table: "table",
};

/**
 * Where a box of `role` on a slide of `layout` goes when nothing says where:
 * where the layout's template puts a box of that role, or, when it places
 * none, where the layout the role is most at home in does; and for a box with
 * no role, `DEFAULT_BOX_FRAME`.
 */
export function defaultFrameOf(role: BoxRole | null, layout: SlideLayout): Frame {
	if (role === null) return DEFAULT_BOX_FRAME;
	const template = templateBoxOf(layout, role) ?? templateBoxOf(ROLE_HOMES[role], role);
	return template?.frame ?? DEFAULT_BOX_FRAME;
}
