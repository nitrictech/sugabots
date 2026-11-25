import type { ArtifactImageType } from "@sugabots/contracts";
import { type ArtifactImageIds, ownImageAt } from "@sugabots/contracts/http";
import { linkMayGoTo } from "@sugabots/contracts/live-document";
import { SLIDE_COLUMN } from "@sugabots/contracts/live-slides";
import type { SlideLayout } from "@sugabots/contracts/slides-markdown";
import type { Node } from "@tiptap/pm/model";

/*
 * A deck's slides as the app draws them, in its light colours, for the files
 * a deck is saved as: a PowerPoint file (`powerpoint.ts`) and a PDF
 * (`pdf.ts`). It follows the slide styles in the web app's `app.css`, which
 * size everything in a unit of a 60th of the slide's width: a slide is 60
 * units wide and 33.75 tall. Its text is drawn at full size, or at the
 * largest of `SLIDE_TEXT_STEPS` at which it fits, and everything sized in
 * ems of the slide's text steps down with it, while its padding, which is in
 * the unit alone, stays.
 *
 * Positions and sizes in points are on a slide 960 wide, a point to each
 * pixel of a slide the app draws 960 pixels wide, where the unit is 16.
 */

/** The slide's unit, in points. */
export const EM = 16;
export const SLIDE_WIDTH = 60 * EM;
export const SLIDE_HEIGHT = 33.75 * EM;
export const PADDING_X = 5 * EM;
export const PADDING_Y = 4 * EM;
export const CONTENT_WIDTH = SLIDE_WIDTH - 2 * PADDING_X;
export const CONTENT_BOTTOM = SLIDE_HEIGHT - PADDING_Y;

/** The space between a slide's two columns, in units. */
export const COLUMN_GAP_UNITS = 3.5;

/** The quote layout's wider padding at either side, in units. */
export const QUOTE_PADDING_UNITS = 7;

/** The light colours, as hex: a deck holds no theme, and a file to hand on is light. */
export const BACKGROUND = "FFFFFF";
export const TEXT = "111113";
export const SECONDARY = "52525B";
export const ACCENT = "2563EB";
export const RULE = "E4E4E7";
export const TINT = "F4F4F5";

/** A rule's thickness, in points: a pixel, which doesn't step down. */
export const RULE_THICKNESS = 1;

/** How a kind of text on a slide looks. */
export interface TextLook {
	/** In units, at full size. */
	size: number;
	color: string;
	/** As CSS weighs it: 400 regular, 500 medium, 600 semibold, 700 bold. */
	weight: number;
	/** A multiple of its size. */
	lineHeight: number;
	/** The space after each letter, in ems of its size. */
	tracking: number;
}

/** The weight from which a format with only regular and bold draws text bold. */
export const BOLD_WEIGHT = 600;

/** How a layout sets out the blocks a slide holds, one under another. */
export interface LayoutLook {
	/** Each heading's look, whatever its level up to the third, as all are drawn alike. */
	heading: TextLook;
	/** The look of its paragraphs, and of its lists' and quotes' text. */
	text: TextLook;
	/** The space between its blocks, in units of its text's step. */
	gap: number;
	/** Where its blocks sit within its padding when they take less than its height. */
	align: "start" | "center" | "end";
}

const HEADING: TextLook = {
	size: 2.5,
	color: TEXT,
	weight: 600,
	lineHeight: 1.15,
	tracking: -0.01,
};
const BODY_TEXT: TextLook = { size: 1.5, color: TEXT, weight: 400, lineHeight: 1.4, tracking: 0 };
const SMALL_TEXT: TextLook = { ...BODY_TEXT, size: 1.25 };
const BODY: LayoutLook = { heading: HEADING, text: BODY_TEXT, gap: 2, align: "start" };

/** Each layout's look, as `[data-layout=…]` sets it. */
export const LAYOUT_LOOKS: Readonly<Record<SlideLayout, LayoutLook>> = {
	/** A large title, and its subtitle under it, in the middle. */
	title: {
		heading: { ...HEADING, size: 3.75, weight: 700, lineHeight: 1.1, tracking: -0.02 },
		text: { ...BODY_TEXT, color: SECONDARY },
		gap: 1.25,
		align: "center",
	},
	bullets: BODY,
	/** The title across the top, and the columns side by side under it (`COLUMN_LOOK`). */
	columns: BODY,
	/** The title and the first column's text on the left (`IMAGE_LAYOUT`), and the second column, its image, on the right. */
	image: BODY,
	/** An accent bar (`SECTION_BAR`), a label and a very large title, at the foot of the slide. */
	section: {
		heading: { ...HEADING, size: 4, weight: 700, lineHeight: 1.05, tracking: -0.02 },
		text: { ...SMALL_TEXT, color: SECONDARY, weight: 500 },
		gap: 1,
		align: "end",
	},
	/** The quote large (`QUOTE_LOOK`), and who said it under it, in the middle, within wider padding. */
	quote: { ...BODY, text: { ...SMALL_TEXT, color: SECONDARY }, gap: 1.75, align: "center" },
	table: { ...BODY, text: SMALL_TEXT },
};

/** A column's look, in a layout with columns: smaller text and headings, nearer each other. */
export const COLUMN_LOOK = {
	heading: { ...HEADING, size: 1.375, lineHeight: 1.2, tracking: 0 },
	text: SMALL_TEXT,
	/** Between its blocks, in units of the step. */
	gap: 0.9,
	/** Between its lists' items, in ems of their text. */
	listGap: 0.6,
	/** In the columns layout, a rule this far under each heading, in ems of the heading. */
	headingRuleGap: 0.6,
} as const;

/**
 * The parts of a slide that set their blocks each their own way: the slide's
 * own flow, a column of the columns layout, and the image layout's text and
 * the column its image is in.
 */
export type SlidePart = "flow" | "column" | "imageText" | "imageColumn";

/** How a part of a slide sets its blocks, one under another. */
export interface PartLook {
	heading: TextLook;
	text: TextLook;
	/** Between its blocks, in units of the step. */
	gap: number;
	/** Between its lists' items, in ems of their text. */
	listGap: number;
	/** Whether each heading has a rule under it, `COLUMN_LOOK.headingRuleGap` below. */
	ruledHeadings: boolean;
	/** Where its blocks sit across it: the image's column centres each. */
	align: "start" | "center";
}

/** How `part` of a slide of `layout` sets its blocks, as `[data-layout=…]` and `[data-slide-column]` set them. */
export function partLook(layout: SlideLayout, part: SlidePart): PartLook {
	const look = LAYOUT_LOOKS[layout];
	if (part === "flow") {
		return {
			heading: look.heading,
			text: look.text,
			gap: look.gap,
			listGap: LIST_LOOK.gap,
			ruledHeadings: false,
			align: "start",
		};
	}
	const column: PartLook = {
		heading: { ...COLUMN_LOOK.heading, weight: look.heading.weight },
		text: COLUMN_LOOK.text,
		gap: COLUMN_LOOK.gap,
		listGap: COLUMN_LOOK.listGap,
		ruledHeadings: part === "column",
		align: "start",
	};
	if (part === "column") return column;
	return {
		...column,
		text: IMAGE_LAYOUT.text,
		align: part === "imageColumn" ? "center" : "start",
	};
}

/** The image layout: the title, then the first column's text, centred on the left, and the image filling the right. */
export const IMAGE_LAYOUT = {
	/** Both columns' text. */
	text: { ...BODY_TEXT, size: 1.375, color: SECONDARY, lineHeight: 1.5 },
	/** Between the title and the text, in units of the step. */
	titleGap: 1.25,
	/** The image's most height, in units: it doesn't step down with the text. */
	imageMaxHeight: 25,
	/** Its image's corners, in ems of its text. */
	imageRadius: 0.75,
} as const;

/**
 * The quote layout's quote, the blocks of its first block quote. Its letter
 * spacing is set on the quote, a hundredth of the slide's unit, which its
 * larger text takes as it is.
 */
export const QUOTE_LOOK: TextLook = {
	size: 2.5,
	color: TEXT,
	weight: 500,
	lineHeight: 1.25,
	tracking: -0.01 / 2.5,
};

/** The section break's accent bar, in units of the step: its size and its corners. */
export const SECTION_BAR = { width: 3, height: 0.3, radius: 0.15 } as const;

/** A table: its text, and its header row's, on a tint, a rule under each row. */
export const TABLE_LOOK = {
	text: { ...SMALL_TEXT, lineHeight: 1.35 },
	header: { color: SECONDARY, weight: 600 },
	/** The first column's cells below the header. */
	firstColumnWeight: 500,
	/** The padding of its header cells and other cells, in ems of their text. */
	headerPadding: { y: 0.6, x: 0.8 },
	cellPadding: { y: 0.7, x: 0.8 },
	/** Between a cell's blocks, in ems of its text. */
	blockGap: 0.4,
} as const;

/** A list: the space between its items and the indent of their text, in ems of their text. */
export const LIST_LOOK = {
	gap: 0.7,
	indent: 1.2,
	/** Above a list in an item, in ems of its text. */
	nestedGap: 0.5,
} as const;

/** A quote in the flow of a slide: a rule at its left, set off in ems of the text around it, and its text softer. */
export const BLOCK_QUOTE_LOOK = { padding: 0.9, rule: 0.15, color: SECONDARY } as const;

/** Code: a block on a tint, a share of the size of the text around it, and code in a line on a tint of its own. */
export const CODE_LOOK = {
	/** A code block's size, as a share of the text around it. */
	blockScale: 0.75,
	/** In ems of the code block's text. */
	blockPadding: { y: 0.6, x: 0.8 },
	blockRadius: 0.5,
	/** Code in a line: its size as a share of the line's, and its padding and corners in ems of its own. */
	inlineScale: 0.875,
	inlinePadding: { y: 0.1, x: 0.3 },
	inlineRadius: 0.25,
} as const;

/** An image's corners, in ems of the text around it. */
export const IMAGE_RADIUS = 0.5;

/**
 * Where a link in a file a deck is saved as goes: an absolute address a link
 * in the editor may go to, written as its URL in ASCII, percent-encoded as a
 * reader can follow it. A relative address goes somewhere in the app, which a
 * reader would look for beside wherever the file is saved, so it, and an
 * address a link may not go to, is no link in a file: its words are drawn as
 * a link's are, going nowhere.
 */
export function linkInFile(href: unknown): string | undefined {
	if (typeof href !== "string" || !linkMayGoTo(href)) return undefined;
	try {
		return new URL(href).href;
	} catch {
		return undefined;
	}
}

/** A link keeps its text's colour, underlined this far below the baseline, in ems. */
export const LINK_UNDERLINE_OFFSET = 0.15;

/** Highlighted text: the app's warning colour, light enough to read through, padded and rounded in points. */
export const HIGHLIGHT = { color: "8A5A12", opacity: 0.3, paddingX: 2, radius: 2 } as const;

/**
 * Superscript and subscript: smaller, and raised or lowered by a share of
 * their own size, without making their line taller.
 */
export const SCRIPT = { scale: 0.75, superscriptRaise: 0.5, subscriptDrop: 0.25 } as const;

/**
 * An image that isn't drawn, such as one another artifact keeps: its words
 * in a dashed box, as the app shows one it doesn't load. In points.
 */
export const IMAGE_WORDS_LOOK = {
	color: "52525B",
	border: "D4D4D8",
	padding: { y: 1, x: 6 },
	radius: 4,
} as const;

/** An image a deck keeps: its bytes, and their media type. */
export interface DeckImage {
	contentType: ArtifactImageType;
	bytes: Uint8Array;
}

/** What a slide holds, as its layouts place it. */
export interface SlideBlocks {
	/** Its first block when that is a heading: its title. */
	title: readonly Node[];
	/** Its other blocks outside columns, in order. */
	flow: readonly Node[];
	/** What each of its two columns holds, in a layout with columns. */
	columns: readonly [readonly Node[], readonly Node[]];
}

/** Everything a slide holds, as one flow, in order. */
export const everyBlock = ({ title, flow, columns }: SlideBlocks) => [
	...title,
	...flow,
	...columns.flat(),
];

export function childNamed(node: Node, name: string): Node {
	const child = node.children.find((each) => each.type.name === name);
	if (!child) throw new Error(`A slide holds no ${name}`);
	return child;
}

const isColumn = (block: Node) => block.type.name === SLIDE_COLUMN;

export const isEmptyParagraph = (block: Node) =>
	block.type.name === "paragraph" && block.childCount === 0;

/** A slide's frame as its layouts place it. A third column or more, which a frame fitted to its layout holds none of, goes in the second. */
export function slideBlocksOf(body: Node): SlideBlocks {
	const blocks = body.children;
	const title = blocks[0]?.type.name === "heading" ? blocks.slice(0, 1) : [];
	const rest = blocks.slice(title.length);
	const [first = [], second = [], ...more] = rest.filter(isColumn).map((column) => column.children);
	return {
		title,
		flow: rest.filter((block) => !isColumn(block)),
		columns: [first, [...second, ...more.flat()]],
	};
}

/** The images in the deck that `artifact` keeps, once each, by address. */
export function ownImagesIn(
	deck: Node,
	artifact: { podId: string; artifactId: string },
): [string, ArtifactImageIds][] {
	const own = new Map<string, ArtifactImageIds>();
	deck.descendants((node) => {
		const address: unknown = node.type.name === "image" ? node.attrs.src : undefined;
		if (typeof address !== "string") return;
		const ids = ownImageAt(address, artifact);
		if (ids) own.set(address, ids);
	});
	return [...own];
}
