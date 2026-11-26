import type { ArtifactImageType } from "@sugabots/contracts";
import { type ArtifactImageIds, ownImageAt } from "@sugabots/contracts/http";
import { linkMayGoTo } from "@sugabots/contracts/live-document";
import { layoutOf, shownBoxesOf } from "@sugabots/contracts/live-slides";
import {
	type BoxRole,
	type BoxRoleOf,
	type Frame,
	SLIDE_BOX_ROLES,
	SLIDE_END_MARGIN,
	SLIDE_HEIGHT,
	SLIDE_SIDE_MARGINS,
	SLIDE_WIDTH,
	type SlideLayout,
} from "@sugabots/contracts/slides-markdown";
import type { Node } from "@tiptap/pm/model";

/*
 * A deck's slides as the app draws them, in its light colours, for the files
 * a deck is saved as: a PowerPoint file (`powerpoint.ts`) and a PDF
 * (`pdf.ts`). It follows the slide styles in the web app's `app.css`, which
 * size everything in the slide's unit (`SLIDE_UNIT`). Its text is drawn at
 * full size, or at the largest of `SLIDE_TEXT_STEPS` at which it fits, and
 * everything sized in ems of the slide's text steps down with it, while its
 * margins, which are in the unit alone, stay.
 *
 * Positions and sizes in points are a slide's pixels (`SLIDE_WIDTH` across),
 * a point to each.
 */

/** How wide a slide of `layout` is within the margins at its sides, in points. */
export const contentWidthOf = (layout: SlideLayout) => SLIDE_WIDTH - 2 * SLIDE_SIDE_MARGINS[layout];

/** How far down a slide the margin at its foot starts, in points. */
export const CONTENT_BOTTOM = SLIDE_HEIGHT - SLIDE_END_MARGIN;

/** How tall a slide is within the margins at its top and foot, in points. */
export const CONTENT_HEIGHT = SLIDE_HEIGHT - 2 * SLIDE_END_MARGIN;

/** The space between a slide's two columns, in units. */
export const COLUMN_GAP_UNITS = 3.5;

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
	/** The title over the text box on the left, and the image box on the right (`IMAGE_LAYOUT`). */
	image: BODY,
	/** An accent bar (`SECTION_BAR`), a label and a very large title, at the foot of the slide. */
	section: {
		heading: { ...HEADING, size: 4, weight: 700, lineHeight: 1.05, tracking: -0.02 },
		text: { ...SMALL_TEXT, color: SECONDARY, weight: 500 },
		gap: 1,
		align: "end",
	},
	/** The quote large (`QUOTE_LOOK`), and who said it under it, in the middle, within wider margins. */
	quote: { ...BODY, text: { ...SMALL_TEXT, color: SECONDARY }, gap: 1.75, align: "center" },
	table: { ...BODY, text: SMALL_TEXT },
};

/**
 * The look of a column of the columns layout, and, but for their text, of
 * the image layout's text box and image box: smaller text and headings,
 * nearer each other.
 */
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
 * own flow, a column of the columns layout, and the image layout's text box
 * and image box. A box's part is its role's (`BOX_PARTS`).
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
	/** Where its blocks sit across it: the image box centres each. */
	align: "start" | "center";
}

/**
 * The part of its slide a box of each role is, which sets what the box holds
 * as `[data-box-role=…]` sets it: a column of the columns layout, the image
 * layout's text box and image box, and the slide's own flow for every other.
 */
export const BOX_PARTS: Readonly<Record<BoxRole, SlidePart>> = {
	title: "flow",
	subtitle: "flow",
	body: "flow",
	leftColumn: "column",
	rightColumn: "column",
	text: "imageText",
	image: "imageColumn",
	label: "flow",
	quote: "flow",
	attribution: "flow",
	table: "flow",
};

/** How `part` of a slide of `layout` sets its blocks, as `[data-layout=…]` and `[data-box-role=…]` set them. */
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

/**
 * The image layout: its title over its text box, together in the middle of
 * the left, and its image box filling the right.
 */
export const IMAGE_LAYOUT = {
	/** The text of its text box and of its image box. */
	text: { ...BODY_TEXT, size: 1.375, color: SECONDARY, lineHeight: 1.5 },
	/** Between the title and the text, in units of the step. */
	titleGap: 1.25,
	/** Between the title's own blocks: none, as the layout sets nothing between its rows. */
	titleBlockGap: 0,
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

/** The section break's accent bar, in units of the step: its size and its corners. A slide whose label was removed shows none. */
export const SECTION_BAR = { width: 3, height: 0.3, radius: 0.15 } as const;

/**
 * Where the section break's accent bar is, at `unit`, on a slide whose boxes
 * somebody placed by hand: over its label's box, placed at `label`, from the
 * box's left, as far above it as the layout sets its blocks apart, as it goes
 * wherever the label goes. In points.
 */
export function accentBarOver(
	label: Frame,
	unit: number,
): { x: number; y: number; width: number; height: number } {
	const height = SECTION_BAR.height * unit;
	return {
		x: label.x,
		y: label.y - LAYOUT_LOOKS.section.gap * unit - height,
		width: SECTION_BAR.width * unit,
		height,
	};
}

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

/** What a slide of layout `L` holds, as its layout places it, its boxes off the slide left out. */
export interface BlocksOfLayout<L extends SlideLayout> {
	layout: L;
	/**
	 * The blocks of each of its boxes, in the order of its layout's roles
	 * (`SLIDE_BOX_ROLES`): `undefined` for a box off the slide.
	 */
	boxes: readonly (readonly Node[] | undefined)[];
	/** Whether it shows its box of `role`: one that isn't off the slide. */
	shows(role: BoxRoleOf<L>): boolean;
	/**
	 * The blocks of its box of `role`, as the layouts that set boxes beside
	 * each other place them: none when it doesn't show it.
	 */
	inBox(role: BoxRoleOf<L>): readonly Node[];
	/**
	 * Every block in the boxes it shows, in order: what the layouts that set a
	 * slide's blocks one under another set, box after box, as far apart as
	 * each other.
	 */
	all: readonly Node[];
}

/** What a slide holds (`BlocksOfLayout`), told apart by its layout. */
export type SlideBlocks = { [L in SlideLayout]: BlocksOfLayout<L> }[SlideLayout];

export function childNamed(node: Node, name: string): Node {
	const child = node.children.find((each) => each.type.name === name);
	if (!child) throw new Error(`A slide holds no ${name}`);
	return child;
}

export const isEmptyParagraph = (block: Node) =>
	block.type.name === "paragraph" && block.childCount === 0;

/** What `slide`, its body fitted to its layout, holds, as its layout places it. */
export function slideBlocksOf(slide: Node): SlideBlocks {
	const layout = layoutOf(slide);
	const roles: readonly BoxRole[] = SLIDE_BOX_ROLES[layout];
	const boxes = shownBoxesOf(slide).map((box) => box?.children);
	const blocksOf = (role: BoxRole) => boxes[roles.indexOf(role)];
	return {
		layout,
		boxes,
		shows: (role: BoxRole) => blocksOf(role) !== undefined,
		inBox: (role: BoxRole) => blocksOf(role) ?? [],
		all: boxes.flatMap((blocks) => blocks ?? []),
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
