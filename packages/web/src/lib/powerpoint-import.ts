import { MAX_ARTIFACT_IMAGE_BYTES } from "@sugabots/contracts";
import { type CssColor, cssColorIn } from "@sugabots/contracts/css-values";
import { linkMayGoTo } from "@sugabots/contracts/live-document";
import {
	type NewBoxAttributes,
	newBox,
	newSlide,
	SLIDE,
	SLIDE_BODY,
	SPEAKER_NOTES,
} from "@sugabots/contracts/live-slides";
import {
	type BoxPadding,
	type BoxRole,
	paddingIn,
	type Stroke,
	strokeIn,
	type VerticalAlign,
} from "@sugabots/contracts/slide-box";
import { type Frame, frameIn, SLIDE_HEIGHT, SLIDE_WIDTH } from "@sugabots/contracts/slide-geometry";
import { defaultFrameOf } from "@sugabots/contracts/slide-layouts";
import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import { changedPath, type SvgPath, svgPathIn } from "@sugabots/contracts/svg-path";
import type { Editor } from "@tiptap/core";
import { Fragment, type Mark, type Node, type Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type {
	Element as ElementOnSlide,
	Fill,
	Slide as SlideInFile,
	TableCell,
	Table as TableInFile,
} from "pptxtojson";
import { ImageNotKept, type KeepImage, keepableImage } from "./file-import.ts";
import { nodeOf } from "./schema-nodes.ts";
import { dispatchAsOneChange } from "./suggesting.ts";

/** What an import of a PowerPoint file left out. */
export interface PowerPointImported {
	/** How many slides past the most a deck takes from a file (`MAX_IMPORTED_SLIDES`) were left out. */
	slidesLeftOut: number;
	/**
	 * How many images on the file's slides the deck didn't keep: of a kind it
	 * can't show, larger than it keeps, or linked from outside the file.
	 */
	imagesLeftOut: number;
	/**
	 * How many other things on its slides the deck has no place for, such as
	 * a chart, a video or SmartArt, a shape it can't paint, as one filled with
	 * a gradient, unless the file marks that shape as decorative, something
	 * parked off the slide, or a slide's things past the most a deck takes
	 * (`MAX_IMPORTED_BOXES`).
	 */
	othersLeftOut: number;
}

/** The most slides a deck takes from a file, as every slide is drawn in the strip at once. */
export const MAX_IMPORTED_SLIDES = 200;

/** The most boxes a deck takes from one of a file's slides, the topmost. */
export const MAX_IMPORTED_BOXES = 200;

/**
 * Replaces the editor's deck, for everyone in it, with a PowerPoint file's
 * slides (`deckFromPowerPoint`), in one change made as `name`: one
 * suggestion while they are suggesting. Fails, changing nothing, as that does.
 */
export async function importPowerPointFile(
	editor: Editor,
	file: File,
	keepImage: KeepImage,
	name: string,
): Promise<PowerPointImported> {
	const { deck, ...imported } = await deckFromPowerPoint(
		await file.arrayBuffer(),
		editor.schema,
		keepImage,
	);
	const { tr: replacing, doc } = editor.state;
	replacing.replaceWith(0, doc.content.size, deck.content);
	dispatchAsOneChange(editor, replacing.setSelection(TextSelection.atStart(replacing.doc)), name);
	return imported;
}

/**
 * A PowerPoint file's slides as a deck of `schema`, a slide for each of the
 * file's, in order, each looking as it does in the file: a slide of no
 * layout (`blank`), on the file's colour for it (see `slideColorOf`),
 * holding a box for each thing on it, where the file puts it, in the order
 * the file draws them, its master's and layout's graphics first. A file of a
 * shape other than 16:9 is scaled to fit the deck's slides and set in their
 * middle. Words the file places nowhere, as a placeholder the file gives no
 * size, go where a box for what they are goes on a slide of no layout.
 *
 * - Words, in a text box or a shape, keep their paragraphs and lists, the
 *   marks the deck has, their links, colour (black where the file gives
 *   none, and a gradient's first colour for text filled with one), size,
 *   font, alignment and line spacing, and the box its fill, outline, inner
 *   margins, where its words sit in it and its turn. A title, subtitle or
 *   body placeholder's box is for that, and any other is for nothing in
 *   particular.
 * - A shape keeps its outline, as a path, and its fill, unless the file draws
 *   it as an outline alone, as an arc or a bracket, and its outline, and a
 *   line its run, which way the file flips it.
 * - A picture is kept, with the words the file gives for what it shows,
 *   filling its box, a cropped one by being cut to the box's shape about its
 *   middle.
 * - A table keeps its cells' words and its columns' widths, its first row
 *   its header, drawn as the deck draws one. A merged cell's words are in
 *   the first of the cells it spans, and the rest are empty, so no words are
 *   lost; a row with fewer cells than the widest is made as wide with empty
 *   ones.
 * - Each slide's notes are kept, as plain paragraphs.
 *
 * Left out, and counted: charts, videos, sound, SmartArt and equations; a
 * shape without words or an outline that the deck can't paint, as one filled
 * with a gradient, a pattern or a picture, unless the file marks it as
 * decorative; anything parked wholly off the slide, or that the file places
 * nowhere a box can be; the slides and boxes past the most a deck takes
 * (`MAX_IMPORTED_SLIDES`, `MAX_IMPORTED_BOXES`); and the images the deck
 * doesn't keep. Left out without being counted, as the deck draws none: a
 * slide's footer, number and date, an empty text box or placeholder, and a
 * shape that draws nothing.
 *
 * Not kept: a cell's fill and borders, a picture cropped unevenly (it is cut
 * about its middle), shadows, gradients and pictures filling a shape, text or
 * a slide, an outline's dashes and arrowheads, a box's words flipped or set
 * upright, a paragraph's indents and the space around it.
 *
 * Fails when the file can't be read as a PowerPoint file, or with
 * `ImageNotKept` when an image the deck would keep couldn't be: importing
 * without it would take it from the deck for everyone.
 */
export async function deckFromPowerPoint(
	file: ArrayBuffer,
	schema: Schema,
	keepImage: KeepImage,
): Promise<PowerPointImported & { deck: Node }> {
	const { parse } = await import("pptxtojson");
	const { slides, size } = await parse(file, {
		imageMode: "base64",
		singleLineSpacingFactor: SINGLE_LINE_SPACING,
	});
	const shapes = await shapesOnSlides(file);
	const placing = placingOf(size);
	const keep = imageKeeper(keepImage);
	const kept = slides.slice(0, MAX_IMPORTED_SLIDES);
	let imagesLeftOut = 0;
	let othersLeftOut = 0;
	const deckSlides: Node[] = [];
	for (const [index, slide] of kept.entries()) {
		const read = readSlide(slide, shapes[index] ?? new Map(), placing, schema);
		othersLeftOut += read.othersLeftOut;
		const boxes: Node[] = [];
		for (const piece of read.pieces) {
			if (piece.kind === "box") {
				boxes.push(piece.box);
				continue;
			}
			const address = await keep(piece.image);
			if (address === undefined) imagesLeftOut++;
			else boxes.push(pictureBox(piece.attributes, address, piece.image.altText, schema));
		}
		deckSlides.push(
			nodeOf(schema, SLIDE, [nodeOf(schema, SLIDE_BODY, boxes), notesOf(slide.note, schema)], {
				layout: "blank",
				background: slideColorOf(slide.fill),
			}),
		);
	}
	// A deck holds a slide at least, as HTML that says nothing is an empty title slide.
	const deck = schema.topNodeType.create(
		null,
		deckSlides.length > 0 ? deckSlides : [newSlide(schema, "title")],
	);
	deck.check();
	return { deck, slidesLeftOut: slides.length - kept.length, imagesLeftOut, othersLeftOut };
}

/**
 * How tall PowerPoint draws a line of text spaced singly, as a multiple of its
 * size: its line spacing, which the file gives as a multiple of this, as
 * CSS's line height says it.
 */
const SINGLE_LINE_SPACING = 1.2;

/**
 * Where the file's slides go on the deck's: scaled by `scale`, and moved
 * `left` across and `top` down, in a slide's pixels, and how large the
 * file's slides are, `width` across and `height` down, in its points. The
 * file measures in points, which on a 16:9 slide 960 points across are a
 * slide's pixels.
 */
interface Placing {
	scale: number;
	left: number;
	top: number;
	width: number;
	height: number;
}

/** How a file's slides of `size`, in points, fit the deck's: as large as fits, in the middle. */
function placingOf(size: { width: number; height: number }): Placing {
	const { width, height } = size;
	if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
		return { scale: 1, left: 0, top: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT };
	}
	const scale = Math.min(SLIDE_WIDTH / width, SLIDE_HEIGHT / height);
	return {
		scale,
		left: (SLIDE_WIDTH - width * scale) / 2,
		top: (SLIDE_HEIGHT - height * scale) / 2,
		width,
		height,
	};
}

/** Where something sits on a slide of the file, in points from its top left corner. */
interface RectInFile {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** `rect`, on a slide of the file, as a frame on the deck's: `undefined` for one of no size there is. */
const frameOf = ({ left, top, width, height }: RectInFile, placing: Placing): Frame | undefined =>
	frameIn({
		x: hundredths(placing.left + left * placing.scale),
		y: hundredths(placing.top + top * placing.scale),
		width: hundredths(width * placing.scale),
		height: hundredths(height * placing.scale),
	});

/**
 * Whether `rect` is wholly off the file's slide, as PowerPoint lets a thing
 * be parked beside it, out of the show: it touches no part of the slide.
 * Something the file places nowhere it can be, as at a position of no
 * number, is no more off the slide than on it, and isn't.
 */
const isOffSlide = ({ left, top, width, height }: RectInFile, placing: Placing) =>
	left > placing.width || top > placing.height || left + width < 0 || top + height < 0;

/** Whether `frame` covers some of a slide, as words need a box to be set in. */
const hasArea = (frame: Frame | undefined): frame is Frame =>
	frame !== undefined && frame.width > 0 && frame.height > 0;

/** `value` to a hundredth, as precise as a slide's pixels need be. */
const hundredths = (value: number) => Math.round(value * 100) / 100;

/** An image in the file: its bytes as a data URL, empty for one linked from outside the file, and the words the file gives for what it shows. */
interface ImageInFile {
	dataUrl: string;
	altText: string;
}

/** Something on a slide the deck keeps: a box made already, or a picture, to be kept before its box is made. */
type Piece =
	| { kind: "box"; box: Node }
	| { kind: "image"; attributes: NewBoxAttributes; image: ImageInFile };

/** What the file says of a shape that the library doesn't: the placeholder it is, if one, the words it gives for what an image shows, and whether it only decorates the slide. */
interface ShapeInFile {
	placeholder: string | undefined;
	altText: string | undefined;
	decorative: boolean;
}

/** Placeholders that say where a slide is, or when, rather than what it says. */
const DECORATIVE_PLACEHOLDERS = new Set(["ftr", "sldNum", "dt"]);

/** The role of a placeholder's box, by the placeholder's type: one of no type holds content of any kind, mostly a slide's body. */
const PLACEHOLDER_ROLES: Readonly<Record<string, BoxRole>> = {
	title: "title",
	ctrTitle: "title",
	subTitle: "subtitle",
	body: "body",
	obj: "body",
};

/**
 * What of a slide the deck keeps, in the order the file draws it, with its
 * pictures as they are in the file, and how many other things on it the
 * deck has no place for, those wholly off the slide among them. Of more than
 * a deck takes from a slide (`MAX_IMPORTED_BOXES`), the topmost are kept.
 * `shapes` says what the file says of the slide's own shapes; its master's
 * and layout's graphics are none of them.
 */
function readSlide(
	slide: SlideInFile,
	shapes: ReadonlyMap<string, ShapeInFile>,
	placing: Placing,
	schema: Schema,
): { pieces: Piece[]; othersLeftOut: number } {
	const pieces: Piece[] = [];
	let othersLeftOut = 0;
	const drawn = [
		...elementsOn(slide.layoutElements ?? []).map((each) => ({ ...each, shape: undefined })),
		...elementsOn(slide.elements).map((each) => ({ ...each, shape: shapes.get(each.element.id) })),
	];
	for (const { element, rect, shape } of drawn) {
		if (isOffSlide(rect, placing)) {
			othersLeftOut++;
			continue;
		}
		const read = readElement(element, rect, shape, placing, schema);
		if (typeof read === "object") pieces.push(read);
		else if (read === "left out") othersLeftOut++;
	}
	const beyondMost = Math.max(0, pieces.length - MAX_IMPORTED_BOXES);
	return { pieces: pieces.slice(beyondMost), othersLeftOut: othersLeftOut + beyondMost };
}

/**
 * `elements` in the order they are drawn, each where it sits on the slide,
 * a group's as the group places them, the groups themselves left out. A
 * group's turning and flipping are not followed.
 */
function elementsOn(
	elements: readonly ElementOnSlide[],
	offset = { left: 0, top: 0 },
): { element: Exclude<ElementOnSlide, { type: "group" }>; rect: RectInFile }[] {
	return [...elements]
		.sort((one, other) => one.order - other.order)
		.flatMap((element) => {
			const rect = {
				left: element.left + offset.left,
				top: element.top + offset.top,
				width: element.width,
				height: element.height,
			};
			return element.type === "group" ? elementsOn(element.elements, rect) : [{ element, rect }];
		});
}

/**
 * What the deck keeps of `element`, sitting at `rect`: a box of its words or
 * its shape, its table's box, or its picture. Otherwise what is left out:
 * `"left out"`, counted, for a chart, a video, sound, SmartArt or an
 * equation, a shape the deck can't paint (see `deckFromPowerPoint`), or
 * anything but words that the file places nowhere a box can be, and
 * `"nothing"`, not counted, for what the deck draws none of.
 */
function readElement(
	element: Exclude<ElementOnSlide, { type: "group" }>,
	rect: RectInFile,
	shape: ShapeInFile | undefined,
	placing: Placing,
	schema: Schema,
): Piece | "left out" | "nothing" {
	const frame = frameOf(rect, placing);
	switch (element.type) {
		case "text":
		case "shape":
			return readWordsOrShape(element, frame, shape, placing, schema);
		case "table":
			if (element.data.length === 0) return "nothing";
			if (!frame) return "left out";
			return {
				kind: "box",
				box: newBox(schema, { frame }, [tableOf(element, placing, schema)]),
			};
		case "image":
			if (!frame) return "left out";
			return {
				kind: "image",
				attributes: {
					role: "image",
					frame,
					stroke: strokeOf(element.borderWidth, element.borderColor, placing),
					rotation: element.rotate || 0,
				},
				image: { dataUrl: element.base64, altText: shape?.altText ?? "" },
			};
		default:
			return "left out";
	}
}

/**
 * What the deck keeps of a text box or a shape, framed at `frame`, if the file
 * places it anywhere a box can be (see `readElement`). Words of no size, as a
 * placeholder the file gives no size anywhere, go where a box for what they
 * are goes on a slide of no layout (`defaultFrameOf`), rather than one letter
 * a line.
 */
function readWordsOrShape(
	element: Extract<ElementOnSlide, { type: "text" | "shape" }>,
	frame: Frame | undefined,
	shape: ShapeInFile | undefined,
	placing: Placing,
	schema: Schema,
): Piece | "left out" | "nothing" {
	if (DECORATIVE_PLACEHOLDERS.has(shape?.placeholder ?? "")) return "nothing";
	const reading: TextReading = {
		schema,
		sizeScale: placing.scale * ((element.autoFit?.fontScale ?? 100) / 100),
		colored: true,
	};
	const blocks = blocksOf(element.content, reading);
	const worded = blocks.some((block) => block.textContent.trim() !== "");
	const outlineOnly = element.type === "shape" && element.strokeOnly === true;
	const fill = outlineOnly ? null : colorOfFill(element.fill);
	const stroke = strokeOf(element.borderWidth, element.borderColor, placing);
	if (!worded && !fill && !stroke) {
		const unpainted = element.type === "shape" && !outlineOnly && element.fill;
		return unpainted && !shape?.decorative ? "left out" : "nothing";
	}
	const role = PLACEHOLDER_ROLES[shape?.placeholder ?? ""] ?? null;
	const placed = worded && !hasArea(frame) ? defaultFrameOf(role, "blank") : frame;
	if (!placed) return "left out";
	const attributes: NewBoxAttributes = {
		role,
		frame: placed,
		fill,
		stroke,
		path: element.type === "shape" ? pathOf(element, placed) : null,
		verticalAlign: VERTICAL_ALIGNMENTS[element.vAlign] ?? "top",
		padding: paddingOf(element.textInset, placing),
		rotation: element.rotate || 0,
	};
	return { kind: "box", box: newBox(schema, attributes, worded ? blocks : []) };
}

/** Where a box's words sit in it, by the file's word for it. */
const VERTICAL_ALIGNMENTS: Readonly<Record<string, VerticalAlign>> = {
	up: "top",
	mid: "middle",
	down: "bottom",
};

/** The colour `fill` paints, when it is a colour alone. */
const colorOfFill = (fill: Fill | null | undefined): CssColor | null =>
	fill?.type === "color" ? cssColorIn(fill.value) : null;

/** What a slide of the file is drawn on where nothing else can be: what PowerPoint draws a slide on by default. */
const WHITE = cssColorIn("#ffffff");

/**
 * The colour a slide filled with `fill` is drawn on: its own colour, or, for
 * a fill the deck can't paint, the colour nearest what its text is coloured
 * to be read on: a gradient's middle colour, a pattern's background, and
 * white behind a picture, as for a fill of no colour the deck can read. Never
 * none, which would draw the slide on the theme's colour, though its text
 * keeps the file's.
 */
function slideColorOf(fill: Fill | null | undefined): CssColor | null {
	switch (fill?.type) {
		case "color":
			return cssColorIn(fill.value) ?? WHITE;
		case "gradient":
			return middleColorOf(fill.value.colors) ?? WHITE;
		case "pattern":
			return cssColorIn(fill.value.backgroundColor) ?? WHITE;
		default:
			return WHITE;
	}
}

/** The colour of the stop of a gradient's `stops` nearest its middle, each at a percentage of the way along. */
function middleColorOf(stops: readonly { pos: string; color: string }[]): CssColor | null {
	const fromMiddle = ({ pos }: { pos: string }) => Math.abs((Number.parseFloat(pos) || 0) - 50);
	const [nearest] = stops.toSorted((one, other) => fromMiddle(one) - fromMiddle(other));
	return cssColorIn(nearest?.color);
}

/** An outline `width` points wide, of `color`: none when it is no width, as the file says no outline. */
function strokeOf(width: number, color: string, placing: Placing): Stroke | null {
	if (!(width > 0)) return null;
	return strokeIn({ color: cssColorIn(color), width: hundredths(width * placing.scale) });
}

/** A box's inner margins, as the file gives them in points. */
function paddingOf(
	inset: { l: number; t: number; r: number; b: number } | undefined,
	placing: Placing,
): BoxPadding | null {
	if (!inset) return null;
	const side = (points: number) => hundredths(points * placing.scale);
	return paddingIn({
		top: side(inset.t),
		right: side(inset.r),
		bottom: side(inset.b),
		left: side(inset.l),
	});
}

/**
 * The outline of a shape that isn't a plain rectangle, such as an arrow or a
 * line, as a path in its box framed at `frame`, flipped as the file flips
 * it: its path, drawn in the file across its own viewport, stretched across
 * the box. `null` for a rectangle, or for a shape whose outline the file
 * gives no path of.
 */
function pathOf(shape: Extract<ElementOnSlide, { type: "shape" }>, frame: Frame): SvgPath | null {
	const path = shape.shapType === "rect" ? null : svgPathIn(shape.path);
	if (!path) return null;
	const viewport = shape.pathViewBox ?? { x: 0, y: 0, width: shape.width, height: shape.height };
	const scaleTo = (size: number, from: number) => (from > 0 ? size / from : 1);
	const scaleX = scaleTo(frame.width, viewport.width) * (shape.isFlipH ? -1 : 1);
	const scaleY = scaleTo(frame.height, viewport.height) * (shape.isFlipV ? -1 : 1);
	return changedPath(path, {
		scaleX,
		scaleY,
		moveX: shape.isFlipH ? frame.width + viewport.x * Math.abs(scaleX) : -viewport.x * scaleX,
		moveY: shape.isFlipV ? frame.height + viewport.y * Math.abs(scaleY) : -viewport.y * scaleY,
	});
}

/** A picture's box, holding the picture kept at `address`, described by `altText`, alone, filling the box. */
const pictureBox = (
	attributes: NewBoxAttributes,
	address: string,
	altText: string,
	schema: Schema,
) =>
	newBox(schema, attributes, [
		nodeOf(
			schema,
			"paragraph",
			nodeOf(schema, "image", undefined, { src: address, alt: altText || null }),
		),
	]);

/*
 * Reading what a text box says. The library gives it as HTML: paragraphs and
 * lists, each run of text in a `span` styled as the file sets it, sizes in
 * points, and a link as an `a` within.
 */

/** How to read a text box's HTML into the deck's blocks. */
interface TextReading {
	schema: Schema;
	/** What the file's sizes are scaled by, from its points to the deck's pixels, and by how much the file shrinks its text to fit its box. */
	sizeScale: number;
	/**
	 * Whether its text keeps the file's colour, black where the file gives
	 * none, as it does on a slide of the file's own colour; its size, font,
	 * alignment and line spacing are kept either way.
	 */
	colored: boolean;
}

/**
 * The paragraphs and lists `html` holds, nested at their levels, each run of
 * text with the marks the deck has for its style and the colour, size and
 * font the file gives it, and each line with its alignment and line spacing.
 * An empty item of a list is left out; a paragraph holding spaces keeps its
 * line, as it does on the slide.
 */
function blocksOf(html: string, reading: TextReading, look: Look = NO_LOOK): Node[] {
	return blocksIn(new DOMParser().parseFromString(html, "text/html").body, reading, look);
}

/** The elements that hold blocks, rather than sitting in a line of text. */
const BLOCK_ELEMENTS = new Set(["P", "DIV", "LI", "UL", "OL"]);

const isElement = (node: ChildNode): node is Element => node.nodeType === node.ELEMENT_NODE;

const isList = (element: Element) => element.tagName === "UL" || element.tagName === "OL";

/**
 * The blocks of `parent`, its text looking as `look` says unless it says
 * otherwise, words outside any paragraph in it making one of their own,
 * which takes `parent`'s alignment and line spacing.
 */
function blocksIn(parent: Element, reading: TextReading, look: Look): Node[] {
	const { schema } = reading;
	const blocks: Node[] = [];
	// What of `parent` sits in a line of text since the last block in it.
	let inLine: ChildNode[] = [];
	const endLine = () => {
		const inline = inLine.flatMap((child) => inlineOf(child, look, reading));
		if (inline.some((node) => node.isText)) {
			blocks.push(nodeOf(schema, "paragraph", inline, lineAttributesOf(parent, inline, reading)));
		}
		inLine = [];
	};
	for (const child of parent.childNodes) {
		if (!isElement(child) || !BLOCK_ELEMENTS.has(child.tagName)) {
			inLine.push(child);
			continue;
		}
		endLine();
		const within = lookOf(child, look, reading);
		if (isList(child)) blocks.push(...listOf(child, reading, within));
		else blocks.push(...blocksIn(child, reading, within));
	}
	endLine();
	return blocks;
}

/**
 * The list `list` is, its text looking as `look` says, with each item's own
 * list nested in it. A list the library puts straight in another, for a
 * level with no item above it, goes in the item before it, or an empty one.
 */
function listOf(list: Element, reading: TextReading, look: Look): Node[] {
	const { schema } = reading;
	const items: Node[][] = [];
	for (const child of list.children) {
		if (child.tagName === "LI") {
			const blocks = blocksIn(child, reading, lookOf(child, look, reading));
			if (blocks.some((block) => block.textContent.trim() !== "")) items.push(blocks);
		} else if (isList(child)) {
			const nested = listOf(child, reading, lookOf(child, look, reading));
			const last = items.at(-1);
			if (last) last.push(...nested);
			else if (nested.length > 0) items.push(nested);
		}
	}
	if (items.length === 0) return [];
	const listItems = items.map((blocks) =>
		nodeOf(
			schema,
			"listItem",
			// An item starts with its line, which an item holding only a list has empty.
			blocks[0]?.type.name === "paragraph" ? blocks : [nodeOf(schema, "paragraph"), ...blocks],
		),
	);
	return list.tagName === "OL"
		? [nodeOf(schema, "orderedList", listItems, { start: listStartIn(list.getAttribute("start")) })]
		: [nodeOf(schema, "bulletList", listItems)];
}

/** The number a numbered list starts at, as `start` says: a whole number of 1 or more, and 1 otherwise. */
function listStartIn(start: string | null): number {
	const number = Number(start);
	return Number.isSafeInteger(number) && number >= 1 ? number : 1;
}

/** How a run of text looks, as the file sets it and the deck keeps it: the deck's marks, and its colour, size and font. */
interface Look {
	marks: readonly Mark[];
	color?: CssColor;
	/** In a slide's pixels. */
	fontSize?: number;
	fontFamily?: string;
}

const NO_LOOK: Look = { marks: [] };

/** `node`, part of a line of text, as the deck's: its text looking as it and what holds it set, and a line break as one. */
function inlineOf(node: ChildNode, look: Look, reading: TextReading): Node[] {
	if (node.nodeType === node.TEXT_NODE) return textOf(node.textContent ?? "", look, reading);
	if (!isElement(node)) return [];
	if (node.tagName === "BR") return [nodeOf(reading.schema, "hardBreak")];
	const within = lookOf(node, look, reading);
	return [...node.childNodes].flatMap((child) => inlineOf(child, within, reading));
}

/**
 * `text` looking as `look` says, each line break in it a break of the line.
 * A link is drawn underlined, and the file underlines it for that alone, so
 * its underline isn't kept as a mark of its own.
 */
function textOf(text: string, look: Look, reading: TextReading): Node[] {
	const { schema } = reading;
	const linked = look.marks.some((mark) => mark.type.name === "link");
	const marks = linked ? look.marks.filter((mark) => mark.type.name !== "underline") : look.marks;
	const styled = textStyleOf(look, reading);
	const kept = styled ? styled.addToSet(marks) : marks;
	return text
		.split(LINE_BREAK)
		.flatMap((line, index) => [
			...(index > 0 ? [nodeOf(schema, "hardBreak")] : []),
			...(line === "" ? [] : [schema.text(line, kept)]),
		]);
}

const LINE_BREAK = /\r\n|\r|\n/;

/** The colour a run of text is given where the file gives none: what PowerPoint draws it in on a slide of its own colour. */
const BLACK = cssColorIn("#000000");

/** The text style mark `look` gives a run: its colour, black when the reading keeps colours, its size and its font. */
function textStyleOf(look: Look, reading: TextReading): Mark | undefined {
	const color = reading.colored ? (look.color ?? BLACK) : undefined;
	const attributes = { color, fontSize: look.fontSize, fontFamily: look.fontFamily };
	if (Object.values(attributes).every((value) => value === undefined)) return undefined;
	return reading.schema.marks[TEXT_STYLE]?.create(attributes);
}

/** The marks the deck has for a run's style, by name: what a style says it is. */
const MARKS_OF_STYLES: Readonly<
	Record<string, (style: Readonly<Record<string, string>>) => boolean>
> = {
	bold: (style) => /^(bold|bolder|[6-9]00)$/.test(style["font-weight"] ?? ""),
	italic: (style) => /^(italic|oblique)/.test(style["font-style"] ?? ""),
	underline: (style) => decorationOf(style).includes("underline"),
	strike: (style) => decorationOf(style).includes("line-through"),
	superscript: (style) => style["vertical-align"] === "super",
	subscript: (style) => style["vertical-align"] === "sub",
};

const decorationOf = (style: Readonly<Record<string, string>>) =>
	`${style["text-decoration"] ?? ""} ${style["text-decoration-line"] ?? ""}`;

/**
 * `look` with what `element` adds: the marks its style says, a link where a
 * link may go, and the colour, size and font it sets.
 */
function lookOf(element: Element, look: Look, reading: TextReading): Look {
	const { schema } = reading;
	const style = styleOf(element);
	const href = element.tagName === "A" ? element.getAttribute("href") : null;
	const added = [
		...Object.entries(MARKS_OF_STYLES).flatMap(([name, says]) =>
			says(style) ? [schema.marks[name]?.create()] : [],
		),
		...(href && linkMayGoTo(href) ? [schema.marks.link?.create({ href })] : []),
	];
	const fontSize = pointsIn(style["font-size"]);
	return {
		marks: added.reduce<readonly Mark[]>(
			(set, mark) => (mark ? mark.addToSet(set) : set),
			look.marks,
		),
		color: textColorIn(style) ?? look.color,
		fontSize: fontSize === undefined ? look.fontSize : hundredths(fontSize * reading.sizeScale),
		fontFamily: fontFamilyIn(style["font-family"]) ?? look.fontFamily,
	};
}

/**
 * The colour `style`, a run's, gives its text, if it gives one. Text the file
 * fills with a gradient, which the library draws as a transparent colour over
 * the gradient clipped to the text, takes the gradient's first colour, or
 * black, as the deck colours text with one colour.
 */
function textColorIn(style: Readonly<Record<string, string>>): CssColor | undefined {
	const clip = style["background-clip"] ?? style["-webkit-background-clip"];
	if (clip === "text") {
		return firstColorIn(style.background ?? style["background-image"]) ?? BLACK ?? undefined;
	}
	return cssColorIn(style.color) ?? undefined;
}

/** The colour of the first stop of `gradient`, a CSS gradient, as `linear-gradient(90deg, #f00 0%, #00f 100%)`. */
function firstColorIn(gradient: string | undefined): CssColor | undefined {
	const [, stops] = /gradient\((.*)\)\s*$/i.exec(gradient ?? "") ?? [];
	for (const stop of splitOutsideBrackets(stops ?? "")) {
		// A stop is its colour and where it is; the gradient's direction, before them, is no colour.
		const color = cssColorIn(stop.trim().replace(/\s+[-+\d.]+%?$/, ""));
		if (color) return color;
	}
	return undefined;
}

/** `list` split at each comma that isn't within brackets, as between a colour function's numbers. */
function splitOutsideBrackets(list: string): string[] {
	const parts = [""];
	let depth = 0;
	for (const character of list) {
		if (character === "(") depth++;
		if (character === ")") depth--;
		if (character === "," && depth === 0) parts.push("");
		else parts[parts.length - 1] += character;
	}
	return parts;
}

/** An element's inline style, by property. */
function styleOf(element: Element): Record<string, string> {
	const declarations = (element.getAttribute("style") ?? "").matchAll(/([\w-]+)\s*:\s*([^;]*)/g);
	return Object.fromEntries(
		[...declarations].map(([, property = "", value = ""]) => [property, value.trim()]),
	);
}

/** The positive number of points `value` says, as `18pt`: `undefined` for anything else. */
function pointsIn(value: string | undefined): number | undefined {
	const [, number] = /^(\d+\.?\d*|\.\d+)pt$/.exec(value ?? "") ?? [];
	const points = Number(number);
	return number !== undefined && points > 0 && Number.isFinite(points) ? points : undefined;
}

/** A font's name the deck keeps: letters, digits, spaces and a few marks, nothing that could end a style. */
const FONT_NAME = /^[\p{L}\p{N} _.-]+$/u;

/** Words in a font's name that say it has serifs, such as the browser's default. */
const SERIF_NAMES =
	/\b(serif|times|georgia|garamond|cambria|elephant|bodoni|baskerville|palatino|book antiqua|didot|caslon)\b/i;

/**
 * The font `value`, a `font-family` the file gives, names first, as the deck
 * keeps it: that font, then whichever of the browser's own serif or sans
 * serif fonts it is likelier to look like, for a browser that lacks it,
 * which would otherwise draw it in its default font. `undefined` when it
 * names no font the deck can keep.
 */
function fontFamilyIn(value: string | undefined): string | undefined {
	const [first] = (value ?? "").split(",");
	const name = first
		?.trim()
		.replace(/^(["'])(.*)\1$/, "$2")
		.trim();
	if (!name || !FONT_NAME.test(name)) return undefined;
	const generic = SERIF_NAMES.test(name) && !/\bsans\b/i.test(name) ? "serif" : "sans-serif";
	return `"${name}", ${generic}`;
}

/**
 * The alignment and line spacing the file gives the line `element` holds,
 * whose text is `inline`: its line spacing as a multiple of its text's size,
 * and single spacing (`SINGLE_LINE_SPACING`) where the file gives none. A
 * spacing the file gives in points is taken as a multiple of the line's
 * largest text.
 */
function lineAttributesOf(element: Element, inline: readonly Node[], reading: TextReading) {
	const style = styleOf(element);
	const textAlign = ["center", "right", "justify"].includes(style["text-align"] ?? "")
		? style["text-align"]
		: null;
	const multiple = Number(style["line-height"]);
	const points = pointsIn(style["line-height"]);
	const largest = Math.max(
		0,
		...inline.map(
			(node) => node.marks.find((mark) => mark.type.name === TEXT_STYLE)?.attrs.fontSize ?? 0,
		),
	);
	const lineHeight =
		multiple > 0 && Number.isFinite(multiple)
			? multiple
			: points !== undefined && largest > 0
				? (points * reading.sizeScale) / largest
				: SINGLE_LINE_SPACING;
	return { textAlign, lineHeight: hundredths(lineHeight) };
}

/** Each line of `blocks`, its paragraphs' and its lists' items' alike, as its inline content. */
const linesOf = (blocks: readonly Node[]): (readonly Node[])[] =>
	blocks.flatMap((block) =>
		block.isTextblock ? [block.content.content] : linesOf(block.children),
	);

/**
 * A table of the cells' words, the first row its header row, drawn as the
 * deck draws one, so its words take the deck's colours, as the header's fill
 * isn't kept; the other cells' words keep the file's colours, or the cell's
 * own. Each column is as wide as the file makes it.
 */
function tableOf({ data: rows, colWidths }: TableInFile, placing: Placing, schema: Schema): Node {
	const width = Math.max(1, ...rows.map((row) => row.length));
	const columnWidth = (column: number) => {
		const points = colWidths?.[column];
		return points && points > 0 ? [Math.round(points * placing.scale)] : null;
	};
	const cellOf = (cell: TableCell | undefined, header: boolean, column: number) => {
		const reading: TextReading = { schema, sizeScale: placing.scale, colored: !header };
		// A cell holding only spaces keeps its line, at the size the file gives it, as the other cells of its row are.
		const blocks = blocksOf(cell?.text ?? "", reading, cellLookOf(cell, header, schema));
		const kept =
			blocks.length > 0
				? blocks.map((block) => (header ? withoutBold(block) : block))
				: [nodeOf(schema, "paragraph")];
		return nodeOf(schema, header ? "tableHeader" : "tableCell", kept, {
			colwidth: columnWidth(column),
		});
	};
	return nodeOf(
		schema,
		"table",
		rows.map((row, rowIndex) =>
			nodeOf(
				schema,
				"tableRow",
				Array.from({ length: width }, (_cell, column) =>
					cellOf(row[column], rowIndex === 0, column),
				),
			),
		),
	);
}

/**
 * How the text of `cell` looks where its runs say nothing: in the cell's
 * own colour, and bold when the file sets the cell bold, but in the header,
 * which is drawn as the deck draws one.
 */
function cellLookOf(cell: TableCell | undefined, header: boolean, schema: Schema): Look {
	if (header || !cell) return NO_LOOK;
	const bold = cell.fontBold ? schema.marks.bold?.create() : undefined;
	return { marks: bold ? [bold] : [], color: cssColorIn(cell.fontColor) ?? undefined };
}

/**
 * `node` without bold. A table's header row is drawn bold, and a file sets a
 * header bold for that alone, so it isn't kept as a mark of its own there.
 */
function withoutBold(node: Node): Node {
	if (node.isText) return node.mark(node.marks.filter((mark) => mark.type.name !== "bold"));
	return node.copy(Fragment.fromArray(node.children.map(withoutBold)));
}

/**
 * A slide's notes as the deck's: plain paragraphs, a line each, with the
 * marks they have, in the colours and sizes of the deck's notes. An empty
 * line is left out.
 */
function notesOf(html: string, schema: Schema): Node {
	const reading: TextReading = { schema, sizeScale: 1, colored: false };
	const lines = linesOf(blocksOf(html, reading)).flatMap((line) => {
		const split: Node[][] = [[]];
		for (const inline of line) {
			if (inline.type.name === "hardBreak") split.push([]);
			else split.at(-1)?.push(plain(inline));
		}
		return split.filter((words) => words.some((word) => word.text?.trim()));
	});
	const paragraphs = lines.map((words) => nodeOf(schema, "paragraph", words));
	return nodeOf(
		schema,
		SPEAKER_NOTES,
		paragraphs.length > 0 ? paragraphs : [nodeOf(schema, "paragraph")],
	);
}

/** `inline` without a text style, as the deck's notes are drawn in its own. */
const plain = (inline: Node): Node =>
	inline.mark(inline.marks.filter((mark) => mark.type.name !== TEXT_STYLE));

/*
 * Keeping the file's images.
 */

/**
 * Keeps an image of the file's with `keepImage`, once however many slides
 * show it, answering its address, or `undefined` for one the deck doesn't
 * keep (`keepableImage`), or one linked from outside the file. Fails with
 * `ImageNotKept` when one the deck would keep couldn't be.
 */
function imageKeeper(keepImage: KeepImage): (image: ImageInFile) => Promise<string | undefined> {
	const kept = new Map<string, Promise<string | undefined>>();
	const keep = async (dataUrl: string) => {
		const bytes = bytesOf(dataUrl);
		const keepable = bytes && keepableImage(bytes);
		if (!keepable) return undefined;
		try {
			return await keepImage(keepable);
		} catch (failure) {
			throw new ImageNotKept(failure);
		}
	};
	return ({ dataUrl }) => {
		const keeping = kept.get(dataUrl) ?? keep(dataUrl);
		kept.set(dataUrl, keeping);
		return keeping;
	};
}

/**
 * The longest a data URL of an image a deck keeps can be: its bytes, at most
 * `MAX_ARTIFACT_IMAGE_BYTES`, written 3 to every 4 characters, and room for
 * what it says before them, as `data:image/jpeg;base64,`.
 */
const LONGEST_KEPT_DATA_URL = Math.ceil(MAX_ARTIFACT_IMAGE_BYTES / 3) * 4 + 256;

/**
 * The bytes in a data URL, or `undefined` for none, for one that isn't
 * base64, or for one longer than an image a deck keeps, which is never read.
 */
function bytesOf(dataUrl: string): Uint8Array | undefined {
	const comma = dataUrl.indexOf(",");
	if (!dataUrl.startsWith("data:") || comma < 0 || dataUrl.length > LONGEST_KEPT_DATA_URL) {
		return undefined;
	}
	let decoded: string;
	try {
		decoded = atob(dataUrl.slice(comma + 1));
	} catch {
		return undefined;
	}
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
	return bytes;
}

/*
 * Reading what the library leaves out of the file's slides: which shapes are
 * placeholders, and of what, the words an image is given, and which shapes
 * are marked as decorative.
 */

const PRESENTATION_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main";
const RELATIONSHIP_NAMESPACE =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DECORATIVE_NAMESPACE = "http://schemas.microsoft.com/office/drawing/2017/decorative";

/**
 * What the file says of each slide's shapes, in the order of its slides, as
 * the library orders them, by each shape's id. Empty for a file that can't be
 * read so, whose slides are then read without it.
 */
async function shapesOnSlides(file: ArrayBuffer): Promise<Map<string, ShapeInFile>[]> {
	try {
		const { default: JSZip } = await import("jszip");
		const zip = await JSZip.loadAsync(file);
		const read = async (path: string) =>
			new DOMParser().parseFromString(
				(await zip.file(path)?.async("string")) ?? "",
				"application/xml",
			);
		const relationships = await read("ppt/_rels/presentation.xml.rels");
		const targets = new Map(
			[...relationships.getElementsByTagName("Relationship")].map((relationship) => [
				relationship.getAttribute("Id"),
				relationship.getAttribute("Target"),
			]),
		);
		const slides = [
			...(await read("ppt/presentation.xml")).getElementsByTagNameNS(
				PRESENTATION_NAMESPACE,
				"sldId",
			),
		].map((slide) => targets.get(slide.getAttributeNS(RELATIONSHIP_NAMESPACE, "id")));
		return await Promise.all(
			slides.map(async (target) => (target ? shapesIn(await read(partAt(target))) : new Map())),
		);
	} catch {
		return [];
	}
}

/** The part a target of the presentation's relationships names: from the package's root, or from `ppt/`. */
const partAt = (target: string) => (target.startsWith("/") ? target.slice(1) : `ppt/${target}`);

function shapesIn(slide: Document): Map<string, ShapeInFile> {
	return new Map(
		[...slide.getElementsByTagNameNS(PRESENTATION_NAMESPACE, "cNvPr")].map((properties) => {
			const placeholder = properties.parentElement?.getElementsByTagNameNS(
				PRESENTATION_NAMESPACE,
				"ph",
			)[0];
			return [
				properties.getAttribute("id") ?? "",
				{
					// A placeholder of no type is one for content of any kind.
					placeholder: placeholder && (placeholder.getAttribute("type") ?? "obj"),
					altText: properties.getAttribute("descr") ?? undefined,
					decorative: isMarkedDecorative(properties),
				},
			];
		}),
	);
}

/** Whether a shape's `properties` hold PowerPoint's mark for a shape that only decorates the slide. */
const isMarkedDecorative = (properties: Element) =>
	[...properties.getElementsByTagNameNS(DECORATIVE_NAMESPACE, "decorative")].some((mark) =>
		["1", "true"].includes(mark.getAttribute("val") ?? ""),
	);
