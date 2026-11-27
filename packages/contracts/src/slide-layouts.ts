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
 * Each frame is sized, in the slide's unit, for the text the slide styles
 * draw a box of its role with: a title of one line, of headings 2.5 units
 * high at a line height of 1.15, body text of 1.5 units at 1.4, and the
 * spaces between boxes the styles keep between blocks.
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
	/**
	 * What a box of its role keeps when its slide leaves this layout for
	 * another that places one too: all it holds, or only the heading it
	 * starts with, what follows going on as a box of no place in the new
	 * layout does (see `laidOutAnew`).
	 */
	readonly keepsOnLeaving: "all" | "leadingHeading";
}

const placed = <R extends BoxRole>(
	role: R,
	frame: Frame,
	verticalAlign: VerticalAlign = "top",
	keepsOnLeaving: TemplateBox["keepsOnLeaving"] = "all",
) => ({ role, frame, verticalAlign, keepsOnLeaving }) as const;

const units = (count: number) => count * SLIDE_UNIT;

const CONTENT_WIDTH = SLIDE_WIDTH - 2 * SLIDE_SIDE_MARGIN;
const CONTENT_BOTTOM = SLIDE_HEIGHT - SLIDE_END_MARGIN;

/** Where the box under `frame` starts, `gap` below its foot. */
const below = (frame: Frame, gap: number) => frame.y + frame.height + gap;

/** The space between a title and what is under it, as the slide styles keep between blocks. */
const BLOCK_GAP = units(2);

/** The space between a large title and the words that go with it: closer, as they are one thing. */
const CAPTION_GAP = units(1.25);

/** A title across a slide's top: one line of its heading, rounded up to whole units. */
const TOP_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: SLIDE_END_MARGIN,
	width: CONTENT_WIDTH,
	height: units(3),
};

/** What goes under a title across the top, down to the margin at the slide's foot. */
const UNDER_TOP_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: below(TOP_TITLE, BLOCK_GAP),
	width: CONTENT_WIDTH,
	height: CONTENT_BOTTOM - below(TOP_TITLE, BLOCK_GAP),
};

const COLUMN_GAP = units(3.5);
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;
const RIGHT_COLUMN = SLIDE_SIDE_MARGIN + COLUMN_WIDTH + COLUMN_GAP;

/** The title slide's title: a line of it and a line of its subtitle straddle the slide's middle. */
const TITLE_SLIDE_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: units(6.25),
	width: CONTENT_WIDTH,
	height: units(11),
};

/** The image layout's title, over its text, in the middle of the left. */
const IMAGE_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: units(7),
	width: COLUMN_WIDTH,
	height: units(6.5),
};

/** A section break's very large title, a line of it at the slide's foot. */
const SECTION_TITLE: Frame = {
	x: SLIDE_SIDE_MARGIN,
	y: CONTENT_BOTTOM - units(4.5),
	width: CONTENT_WIDTH,
	height: units(4.5),
};

/** How tall a section break's label is: a line of its small text. It sits a unit over the title. */
const SECTION_LABEL_HEIGHT = units(1.75);

const QUOTE_MARGIN = SLIDE_SIDE_MARGINS.quote;
const QUOTE_WIDTH = SLIDE_WIDTH - 2 * QUOTE_MARGIN;

/** A quote, three lines of it in the slide's middle with who said it under it. */
const QUOTE: Frame = { x: QUOTE_MARGIN, y: units(6), width: QUOTE_WIDTH, height: units(13.5) };

/**
 * The boxes each layout places, in the order a new slide of it holds them,
 * which is the order they are drawn in, each over the one before. Where a
 * layout sets its boxes in the slide's middle or at its foot, the boxes that
 * may grow as they fill sit with what they hold at the edge the others are
 * on, so a title of more lines grows away from its subtitle, not into it.
 */
export const SLIDE_TEMPLATES = {
	/** A large title, and a subtitle under it, in the middle. */
	title: [
		placed("title", TITLE_SLIDE_TITLE, "bottom"),
		placed("subtitle", {
			x: SLIDE_SIDE_MARGIN,
			y: below(TITLE_SLIDE_TITLE, CAPTION_GAP),
			width: CONTENT_WIDTH,
			height: units(7.25),
		}),
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
		placed("title", IMAGE_TITLE, "bottom"),
		placed("text", {
			x: SLIDE_SIDE_MARGIN,
			y: below(IMAGE_TITLE, CAPTION_GAP),
			width: COLUMN_WIDTH,
			height: units(11),
		}),
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
	/**
	 * A label, such as "Part 2", over a very large title, at the slide's foot.
	 * Its title box holds what another layout's boxes held under their title,
	 * and gives it back as a box of its own when the slide leaves it.
	 */
	section: [
		placed(
			"label",
			{
				x: SLIDE_SIDE_MARGIN,
				y: SECTION_TITLE.y - units(1) - SECTION_LABEL_HEIGHT,
				width: CONTENT_WIDTH,
				height: SECTION_LABEL_HEIGHT,
			},
			"bottom",
		),
		placed("title", SECTION_TITLE, "bottom", "leadingHeading"),
	],
	/** The quote large, and who said it under it, in the middle, within wider margins. */
	quote: [
		placed("quote", QUOTE, "bottom"),
		placed("attribution", {
			x: QUOTE_MARGIN,
			y: below(QUOTE, units(1.75)),
			width: QUOTE_WIDTH,
			height: units(4.5),
		}),
	],
	table: [placed("title", TOP_TITLE), placed("table", UNDER_TOP_TITLE)],
	/** Nothing, for a slide whose boxes go wherever they are put, as one imported from a file. */
	blank: [],
} as const satisfies Record<SlideLayout, readonly TemplateBox[]>;

/** The boxes `layout`'s template places, in order. */
export const templateBoxesOf = (layout: SlideLayout): readonly TemplateBox[] =>
	SLIDE_TEMPLATES[layout];

/** The roles of the boxes a slide of `L`'s template places. */
export type TemplateRoleOf<L extends SlideLayout> = (typeof SLIDE_TEMPLATES)[L][number]["role"];

/** The box of `role` that `layout`'s template places, if it places one. */
export const templateBoxOf = (layout: SlideLayout, role: BoxRole): TemplateBox | undefined =>
	templateBoxesOf(layout).find((box) => box.role === role);

/**
 * How a box of a role fares when its slide is laid out by another layout
 * that places no box of its role (see `laidOutAnew`): whether it may be given
 * the blocks of other such boxes, and whether it goes when it holds nothing,
 * having no place in any layout but its own.
 */
export interface RelayoutRule {
	readonly takesOthers: boolean;
	readonly goesWhenEmpty: boolean;
}

/** The roles whose rule differs from every other's: a label, which says only what part of a deck follows. */
const RELAYOUT_RULES: Partial<Record<BoxRole, RelayoutRule>> = {
	label: { takesOthers: false, goesWhenEmpty: true },
};

const USUAL_RELAYOUT_RULE: RelayoutRule = { takesOthers: true, goesWhenEmpty: false };

export const relayoutRuleOf = (role: BoxRole): RelayoutRule =>
	RELAYOUT_RULES[role] ?? USUAL_RELAYOUT_RULE;

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
	// `ROLE_HOMES` names a layout placing each role, which its type holds it to.
	if (!template) throw new Error(`No layout places a box of the role ${role}`);
	return template.frame;
}
