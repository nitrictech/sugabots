import type { ArtifactImageType } from "@sugabots/contracts";
import { type CssColor, cssColorIn } from "@sugabots/contracts/css-values";
import { type ArtifactImageIds, ownImageAt } from "@sugabots/contracts/http";
import { linkMayGoTo } from "@sugabots/contracts/live-document";
import { boxAttributesOf } from "@sugabots/contracts/live-slides";
import {
	type BoxAttributes,
	type BoxPadding,
	type BoxRole,
	DEFAULT_BOX_PADDING,
	type VerticalAlign,
} from "@sugabots/contracts/slide-box";
import { type Frame, SLIDE_WIDTH } from "@sugabots/contracts/slide-geometry";
import type { SlideLayout } from "@sugabots/contracts/slide-layouts";
import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import { pathCommandsOf, type SvgPath, svgPathIn } from "@sugabots/contracts/svg-path";
import type { Mark, Node } from "@tiptap/pm/model";
import { formatHex, parse } from "culori";

/*
 * A deck's slides as the app draws them, in its light colours, for the files
 * a deck is saved as: a PowerPoint file (`powerpoint.ts`) and a PDF
 * (`pdf.ts`). Each box is drawn at its frame, in the order the slide holds
 * them, with its own fill, outline, shape, padding and rotation. Text that
 * says nothing of its own look is drawn as the slide styles in the web app's
 * `app.css` draw text of its box's role on a slide of its layout, which size
 * everything in the slide's unit (`SLIDE_UNIT`): at full size, or at the
 * largest of `SLIDE_TEXT_STEPS` at which the slide fits, everything sized in
 * ems of the slide's text stepping down with it. Text given a colour, size or
 * font of its own (see `slide-text-style.ts` in the contracts) keeps it.
 *
 * Positions and sizes in points are a slide's pixels (`SLIDE_WIDTH` across),
 * a point to each.
 */

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

/** How a layout styles the blocks its slides' boxes hold, one under another. */
interface LayoutLook {
	/** Each heading's look, whatever its level up to the third, as all are drawn alike. */
	heading: TextLook;
	/** The look of its paragraphs, and of its lists' and quotes' text. */
	text: TextLook;
	/** The space between a box's blocks, in units of its text's step. */
	gap: number;
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
const BODY: LayoutLook = { heading: HEADING, text: BODY_TEXT, gap: 2 };

/** Each layout's look, as `[data-layout=…]` sets it. */
export const LAYOUT_LOOKS: Readonly<Record<SlideLayout, LayoutLook>> = {
	/** A large title, and its subtitle in grey. */
	title: {
		heading: { ...HEADING, size: 3.75, weight: 700, lineHeight: 1.1, tracking: -0.02 },
		text: { ...BODY_TEXT, color: SECONDARY },
		gap: 1.25,
	},
	bullets: BODY,
	/** The columns themselves are set as `COLUMN_LOOK` says. */
	columns: BODY,
	/** Its text box and image box are set as `IMAGE_LAYOUT` says. */
	image: BODY,
	/** An accent bar (`SECTION_BAR`) over its label, and a very large title. */
	section: {
		heading: { ...HEADING, size: 4, weight: 700, lineHeight: 1.05, tracking: -0.02 },
		text: { ...SMALL_TEXT, color: SECONDARY, weight: 500 },
		gap: 1,
	},
	/** The quote large (`QUOTE_LOOK`), and who said it in grey. */
	quote: { ...BODY, text: { ...SMALL_TEXT, color: SECONDARY }, gap: 1.75 },
	table: { ...BODY, text: SMALL_TEXT },
	blank: BODY,
};

/**
 * The look of a column box (`COLUMN_ROLES`): smaller text and headings, nearer
 * each other, its text otherwise as its layout's.
 */
export const COLUMN_LOOK = {
	heading: { ...HEADING, size: 1.375, lineHeight: 1.2, tracking: 0 },
	/** Its text's size, in units. */
	textSize: 1.25,
	/** Between its blocks, in units of the step. */
	gap: 0.9,
	/** Between its lists' items, in ems of their text. */
	listGap: 0.6,
	/** In the columns layout, a rule this far under each heading, in ems of the heading. */
	headingRuleGap: 0.6,
} as const;

/** The roles whose boxes take `COLUMN_LOOK`: the columns, and the text and image beside each other. */
const COLUMN_ROLES: ReadonlySet<BoxRole> = new Set(["leftColumn", "rightColumn", "text", "image"]);

/** The image layout's text box and image box: their text larger, softer and further apart than a column's. */
export const IMAGE_LAYOUT = {
	text: { ...BODY_TEXT, size: 1.375, color: SECONDARY, lineHeight: 1.5 },
} as const;

/**
 * Between the blocks of a box for nothing in particular, and of every box on
 * a blank slide, as a slide imported from a presentation app has, in units of
 * the step: as near as the app spaces a text box's paragraphs.
 */
const TEXT_BOX_GAP = 0.5;

/** How a box sets the blocks it holds, one under another. */
export interface BoxLook {
	heading: TextLook;
	text: TextLook;
	/** Between its blocks, in units of the step. */
	gap: number;
	/** Between its lists' items, in ems of their text. */
	listGap: number;
	/** Whether each heading has a rule under it, `COLUMN_LOOK.headingRuleGap` below. */
	ruledHeadings: boolean;
	/** Whether its tables' cells are padded as a presentation app pads them (`cellInsetOf`). */
	tightCells: boolean;
}

/**
 * How a box of `role` on a slide of `layout` sets its blocks, as the slide
 * styles cascade: its layout's look (`[data-layout=…]`); a column box's
 * smaller one (`COLUMN_LOOK`), its text the image layout's own there
 * (`IMAGE_LAYOUT`); headings ruled off in the columns layout's columns; and
 * a box for nothing in particular, or any box on a blank slide, its blocks
 * nearer (`TEXT_BOX_GAP`), the former's tables' cells padded tighter.
 */
export function boxLookOf(layout: SlideLayout, role: BoxRole | null): BoxLook {
	const look = LAYOUT_LOOKS[layout];
	const column = role !== null && COLUMN_ROLES.has(role);
	const besideImage = layout === "image" && (role === "text" || role === "image");
	const columnText = { ...look.text, size: COLUMN_LOOK.textSize };
	return {
		heading: column ? { ...COLUMN_LOOK.heading, weight: look.heading.weight } : look.heading,
		text: besideImage ? IMAGE_LAYOUT.text : column ? columnText : look.text,
		gap: role === null || layout === "blank" ? TEXT_BOX_GAP : column ? COLUMN_LOOK.gap : look.gap,
		listGap: column ? COLUMN_LOOK.listGap : LIST_LOOK.gap,
		ruledHeadings: layout === "columns" && (role === "leftColumn" || role === "rightColumn"),
		tightCells: role === null,
	};
}

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

/**
 * Where the section break's accent bar is, at `unit`: over its label's box,
 * at `label`, from the box's left, as far above it as the layout sets its
 * blocks apart, as it goes wherever the label goes. In points.
 */
export function accentBarOver(label: Frame, unit: number): Frame {
	const height = SECTION_BAR.height * unit;
	return {
		x: label.x,
		y: label.y - LAYOUT_LOOKS.section.gap * unit - height,
		width: SECTION_BAR.width * unit,
		height,
	};
}

/** Whether a box of `role` on a slide of `layout` has the section break's accent bar over it: its label does. */
export const hasAccentBar = (layout: SlideLayout, role: BoxRole | null) =>
	layout === "section" && role === "label";

/** A table: its text, and its header row's, on a tint, a rule under each row. */
export const TABLE_LOOK = {
	text: { ...SMALL_TEXT, lineHeight: 1.35 },
	header: { color: SECONDARY, weight: 600 },
	/** The first column's cells below the header. */
	firstColumnWeight: 500,
	/** The padding of its header cells and other cells, in ems of their text. */
	headerPadding: { y: 0.6, x: 0.8 },
	cellPadding: { y: 0.7, x: 0.8 },
	/** The padding of every cell of a table in a box for nothing in particular, in points, which doesn't step down: as a presentation app pads one. */
	tightPadding: { y: 4, x: 7 },
	/** Between a cell's blocks, in ems of its text. */
	blockGap: 0.4,
} as const;

/**
 * How far in from a table cell's edges its text starts, in points, the cell's
 * text being `fontSize` points: as a presentation app pads it when `tight`, in
 * a box whose look says so (`BoxLook.tightCells`).
 */
export function cellInsetOf(tight: boolean, header: boolean, fontSize: number) {
	if (tight) return TABLE_LOOK.tightPadding;
	const padding = header ? TABLE_LOOK.headerPadding : TABLE_LOOK.cellPadding;
	return { x: padding.x * fontSize, y: padding.y * fontSize };
}

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

/*
 * Images. An image is drawn upright, as its EXIF orientation says, as a
 * browser draws it. One in the text is as large as it is, but no wider than
 * what it is in. One alone in a box of the image role (`imageFillingBox`)
 * fills the box's content area instead, larger than it is or smaller, as
 * `imageFitOf` says.
 */

/**
 * An image's corners, in ems of the text around it: rounder in the image
 * layout's image box. An image filling a box on a blank slide has square
 * corners (`imageFitOf`).
 */
export const imageRadiusOf = (layout: SlideLayout, role: BoxRole | null) =>
	layout === "image" && role === "image" ? 0.75 : 0.5;

/** How an image fills a box, as CSS's `object-fit` says it: whole within it, or over all of it and cut to it. */
export type ImageFit = "contain" | "cover";

/**
 * How an image alone in a box of the image role fills it on a slide of
 * `layout`: whole within it, in its middle, on a slide made from a template;
 * over all of it, in its middle, cut to it, and with square corners, on a
 * blank slide, as a cropped picture is in a presentation app.
 */
export const imageFitOf = (layout: SlideLayout): ImageFit =>
	layout === "blank" ? "cover" : "contain";

/**
 * The image `box` holds alone, when it fills the box (`imageFitOf`): when the
 * box is of the image role and holds one paragraph holding the image and
 * nothing else. An image with a link is drawn inside the link, so it is in
 * the text, as any other image is. `undefined` for any other box.
 */
export function imageFillingBox(box: Node): Node | undefined {
	if (boxAttributesOf(box).role !== "image" || box.childCount !== 1) return undefined;
	const paragraph = box.child(0);
	if (paragraph.type.name !== "paragraph" || paragraph.childCount !== 1) return undefined;
	const image = paragraph.child(0);
	return image.type.name === "image" && !image.attrs.link ? image : undefined;
}

/** A piece of a paragraph's or heading's line as the files draw it: words, or a picture between them. */
export type TextblockPiece =
	| { kind: "words"; inline: readonly Node[] }
	| { kind: "picture"; image: Node };

/**
 * `block`'s line split at each image, each a piece of its own between the
 * words before and after it, which the files draw on lines of their own: its
 * picture, or its words when the file holds no picture of it. Words that are
 * only spaces beside an image are left out, as they would be a line of
 * nothing. The app draws an image in the line, beside the words around it,
 * which neither file can.
 */
export function piecesOfTextblock(block: Node): TextblockPiece[] {
	const pieces: TextblockPiece[] = [];
	let words: Node[] = [];
	const endWords = () => {
		if (words.length > 0) pieces.push({ kind: "words", inline: words });
		words = [];
	};
	for (const inline of block.children) {
		if (inline.type.name !== "image") {
			words.push(inline);
			continue;
		}
		endWords();
		pieces.push({ kind: "picture", image: inline });
	}
	endWords();
	const holdsImage = pieces.some((piece) => piece.kind === "picture");
	return holdsImage
		? pieces.filter((piece) => piece.kind === "picture" || !piece.inline.every(isOnlySpaces))
		: pieces;
}

const isOnlySpaces = (inline: Node) => inline.isText && (inline.text ?? "").trim() === "";

/**
 * Where an image whose upright size is `natural` is drawn filling `area` as
 * `fit` says: scaled to its width or its height, whichever keeps it whole, or
 * whichever covers the area, in the area's middle.
 */
export function fittedImage(
	natural: { width: number; height: number },
	area: Frame,
	fit: ImageFit,
): Frame {
	const scales = [area.width / natural.width, area.height / natural.height];
	const scale = fit === "contain" ? Math.min(...scales) : Math.max(...scales);
	const width = natural.width * scale;
	const height = natural.height * scale;
	return {
		x: area.x + (area.width - width) / 2,
		y: area.y + (area.height - height) / 2,
		width,
		height,
	};
}

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

/** A colour as a file draws it: six hex digits of sRGB, and how opaque it is, from 0 to 1. */
export interface Paint {
	color: string;
	opacity: number;
}

/**
 * `color` as a file draws it, its channels brought within sRGB: `undefined`
 * for one CSS draws as nothing a file can say, such as `currentcolor`, or one
 * wholly transparent.
 */
export function paintOf(color: CssColor | null): Paint | undefined {
	const parsed = color === null ? undefined : parse(color);
	const hex = formatHex(parsed);
	const opacity = parsed?.alpha ?? 1;
	if (!hex || !(opacity > 0)) return undefined;
	return { color: hex.slice(1).toUpperCase(), opacity: Math.min(1, opacity) };
}

/** How a box itself is drawn, under what it holds: its shape, filled and outlined. */
export interface ShapeLook {
	/** Its outline, in its frame's own points, or `null` for its frame's rectangle. */
	path: SvgPath | null;
	fill: Paint | undefined;
	/** Its outline's colour and width, in points. */
	stroke: { paint: Paint; width: number } | undefined;
}

/** How `box` itself is drawn: nothing of a fill or outline whose colour a file can't draw. */
export function shapeLookOf({ path, fill, stroke }: BoxAttributes): ShapeLook {
	const strokePaint = paintOf(stroke?.color ?? null);
	return {
		path,
		fill: paintOf(fill),
		stroke: stroke && strokePaint ? { paint: strokePaint, width: stroke.width } : undefined,
	};
}

/**
 * How much of a box's frame its outline takes at each side: its width, as the
 * app draws a box's outline within its frame; nothing for a shape, whose
 * outline is drawn on its path, half outside it.
 */
export const outlineInsetOf = ({
	path,
	stroke,
}: {
	path: SvgPath | null;
	stroke: { width: number } | null | undefined;
}): number => (path ? 0 : (stroke?.width ?? 0));

/** Whether a box turned `degrees` clockwise is turned at all: a whole turn, or several, leaves it as it was. */
export const isTurned = (degrees: number) => degrees % 360 !== 0;

/**
 * How far in from each edge of a box's frame what it holds starts, in
 * points: its padding, inside its outline (`outlineInsetOf`).
 */
export function insetsOf(box: BoxAttributes): BoxPadding {
	const { top, right, bottom, left } = box.padding ?? DEFAULT_BOX_PADDING;
	const outline = outlineInsetOf(box);
	return {
		top: top + outline,
		right: right + outline,
		bottom: bottom + outline,
		left: left + outline,
	};
}

/** Where what a box holds is laid out: its frame within its insets (`insetsOf`). */
export function contentAreaOf(box: BoxAttributes): Frame {
	const { top, right, bottom, left } = insetsOf(box);
	const { x, y, width, height } = box.frame;
	return {
		x: x + left,
		y: y + top,
		width: Math.max(0, width - left - right),
		height: Math.max(0, height - top - bottom),
	};
}

/**
 * How far below the top of a box's content area what it holds starts, when
 * it is `height` tall in an area `room` tall, as the box's vertical alignment
 * sits it: what is taller than the area runs past both its edges when in the
 * middle, and past its top when at the foot.
 */
export function alignedOffset(align: VerticalAlign, room: number, height: number): number {
	if (align === "middle") return (room - height) / 2;
	return align === "bottom" ? room - height : 0;
}

/** A stretch of text's own colour, font and size (see `slide-text-style.ts`): `undefined` where it says none. */
export interface OwnTextStyle {
	color: CssColor | undefined;
	/** As CSS lists families, such as `"Source Serif", Georgia, serif`. */
	fontFamily: string | undefined;
	/** In points, never stepped down. */
	fontSize: number | undefined;
}

/**
 * The text style `marks`, a stretch of text's, give it, each part read as its
 * type, its size within `TEXT_SIZES`.
 */
export function ownTextStyleOf(marks: readonly Mark[]): OwnTextStyle {
	const attributes: Readonly<Record<string, unknown>> =
		marks.find((mark) => mark.type.name === TEXT_STYLE)?.attrs ?? {};
	const { color, fontFamily, fontSize } = attributes;
	return {
		color: cssColorIn(color) ?? undefined,
		fontFamily: typeof fontFamily === "string" && fontFamily.trim() !== "" ? fontFamily : undefined,
		fontSize:
			typeof fontSize === "number" && Number.isFinite(fontSize) && fontSize > 0
				? within(fontSize, TEXT_SIZES.least, TEXT_SIZES.most)
				: undefined,
	};
}

/** How a paragraph's or heading's lines sit across it. */
export type TextAlign = "left" | "center" | "right" | "justify";

const TEXT_ALIGNS: readonly unknown[] = ["left", "center", "right", "justify"];

/** `block`'s own alignment, or `undefined` when it sets none and its part's is used. */
export const textAlignOf = (block: Node): TextAlign | undefined =>
	TEXT_ALIGNS.includes(block.attrs.textAlign) ? (block.attrs.textAlign as TextAlign) : undefined;

/**
 * `block`'s own line height, as a multiple of its text's size, at most
 * `MOST_LINE_HEIGHT`, or `undefined` when it sets none.
 */
export function lineHeightOf(block: Node): number | undefined {
	const lineHeight: unknown = block.attrs.lineHeight;
	return typeof lineHeight === "number" && Number.isFinite(lineHeight) && lineHeight > 0
		? Math.min(lineHeight, MOST_LINE_HEIGHT)
		: undefined;
}

/** The number a numbered list starts at: its own, which may be 0 or less, or 1 when it says no whole number. */
export function listStartOf(list: Node): number {
	const start = Number(list.attrs.start);
	return Number.isSafeInteger(start) ? start : 1;
}

/**
 * Whether `block` is a paragraph or heading holding nothing, which the app
 * draws nothing tall, though the space between a box's blocks is kept either
 * side of it, as for any block. (The editor shows a line in one, for the
 * caret; a drawing of the slide, as both files are, shows none.)
 */
export const isEmptyTextblock = (block: Node) =>
	(block.type.name === "paragraph" || block.type.name === "heading") && block.childCount === 0;

/** The most columns a table's cell may span, as browsers bound a cell's `colspan`. */
const MOST_COLUMN_SPAN = 1000;

/** A cell of a table where it sits on the table's grid (`tableGridOf`). */
export interface GridCell {
	cell: Node;
	/** The column it starts at, from 0. */
	column: number;
	/** How many columns it spans. */
	span: number;
}

/**
 * `table` on a grid, as both files lay it out: as many columns as its widest
 * row spans, each cell starting where the cells before it in its row end and
 * spanning as many columns as it says, and a row of fewer leaving the rest of
 * its columns empty. A cell spanning rows is read as spanning one, as neither
 * file holds one that does.
 */
export function tableGridOf(table: Node): { columns: number; rows: GridCell[][] } {
	const rows = table.children.map((row) => {
		let column = 0;
		return row.children.map((cell): GridCell => {
			const said = Number(cell.attrs.colspan);
			const span = Number.isSafeInteger(said) ? within(said, 1, MOST_COLUMN_SPAN) : 1;
			const placed = { cell, column, span };
			column += span;
			return placed;
		});
	});
	const ends = rows.map((cells) => {
		const last = cells.at(-1);
		return last ? last.column + last.span : 0;
	});
	return { columns: Math.max(1, ...ends), rows };
}

/*
 * The numbers a deck holds are finite, as the contracts read them, but may be
 * of any size, as bots and imported files write them, and the files hold only
 * so much: PptxGenJS reads a position of 100 inches or more as the file's own
 * units, PowerPoint keeps text sizes within a range of its own, and PDFKit
 * throws on a number past 10²¹. So the exports read every number of a deck's
 * through these, each bounded far past anything a slide shows.
 */

/** How far a box's edges, its padding and its shape's points may reach, in slide pixels: four slides' widths every way. */
const SLIDE_REACH = 4 * SLIDE_WIDTH;

/** The widest outline a box may have, in slide pixels: PowerPoint's widest line. */
const WIDEST_OUTLINE = 1584;

/** The sizes text may be, in slide pixels: the range PowerPoint holds. */
export const TEXT_SIZES = { least: 1, most: 4000 } as const;

/** The most a line may be tall, as a multiple of its text's size: far more space than any slide shows. */
const MOST_LINE_HEIGHT = 100;

const within = (value: number, least: number, most: number) =>
	Math.min(most, Math.max(least, value));

/**
 * How `box`, one of a slide's boxes, is drawn (`boxAttributesOf`), its
 * numbers bounded: its frame's edges, its padding and its shape's points
 * within `SLIDE_REACH`, its outline no wider than `WIDEST_OUTLINE`, and its
 * turn less than a whole turn. A box reaching further is cut where nothing of
 * the slide shows.
 */
export function drawnAttributesOf(box: Node): BoxAttributes {
	const attributes = boxAttributesOf(box);
	const { frame, padding, stroke, path, rotation } = attributes;
	const reach = (value: number) => within(value, -SLIDE_REACH, SLIDE_REACH);
	const [left, right] = [reach(frame.x), reach(frame.x + frame.width)];
	const [top, bottom] = [reach(frame.y), reach(frame.y + frame.height)];
	const side = (value: number) => within(value, 0, SLIDE_REACH);
	return {
		...attributes,
		frame: { x: left, y: top, width: right - left, height: bottom - top },
		padding: padding && {
			top: side(padding.top),
			right: side(padding.right),
			bottom: side(padding.bottom),
			left: side(padding.left),
		},
		stroke: stroke && { ...stroke, width: within(stroke.width, 0, WIDEST_OUTLINE) },
		path: path && boundedPath(path),
		rotation: rotation % 360,
	};
}

/** `path` with each of its numbers within `SLIDE_REACH`, to a ten-thousandth of a pixel, but an arc's flags and its tilt, within a turn. */
function boundedPath(path: SvgPath): SvgPath | null {
	const commands = pathCommandsOf(path).map(({ letter, values }) => {
		const arc = letter === "a" || letter === "A";
		const numbers = (values as readonly number[]).map((value, index) => {
			if (arc && (index === 3 || index === 4)) return value;
			const bounded = arc && index === 2 ? value % 360 : within(value, -SLIDE_REACH, SLIDE_REACH);
			return Number(bounded.toFixed(4));
		});
		return [letter, ...numbers].join(" ");
	});
	return svgPathIn(commands.join(" "));
}

/** An image a deck keeps: its bytes, and their media type. */
export interface DeckImage {
	contentType: ArtifactImageType;
	bytes: Uint8Array;
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
