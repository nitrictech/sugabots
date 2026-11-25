import { linkMayGoTo } from "@sugabots/contracts/live-document";
import {
	fitSlideBody,
	newSlide,
	SLIDE,
	SLIDE_BODY,
	SLIDE_COLUMN,
	SPEAKER_NOTES,
} from "@sugabots/contracts/live-slides";
import type { SlideLayout } from "@sugabots/contracts/slides-markdown";
import type { Editor } from "@tiptap/core";
import type { Fragment, Mark, Node, Schema } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Element as ElementOnSlide, Slide as SlideInFile, TableCell } from "pptxtojson";
import { ImageNotKept, type KeepImage, keepableImage } from "./file-import.ts";
import { dispatchAsOneChange } from "./suggesting.ts";

/** What an import of a PowerPoint file left out. */
export interface PowerPointImported {
	/**
	 * How many images on the file's slides the deck didn't keep: of a kind it
	 * can't show, larger than it keeps, or linked from outside the file.
	 */
	imagesLeftOut: number;
	/**
	 * How many other things on its slides the deck has no place for, such as
	 * a chart, a video, SmartArt or a shape. A shape's words are kept, so only
	 * a shape without any is counted, unless the file marks it as decorative.
	 */
	othersLeftOut: number;
}

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
 * file's, in order, keeping each image the deck keeps with `keepImage`. A
 * deck is laid out by layouts where a PowerPoint file places boxes, so what
 * the file's slides say is kept and where they put it is not: each slide gets
 * the layout that best fits what it holds (`laidOut`), and its title, its
 * words in the order they are read, with their lists and the marks the deck
 * has, its tables, its images and its notes. A shape's words are kept as
 * paragraphs. Positions, sizes, colours, fonts, backgrounds and the file's
 * masters are left out, and so are shapes without words, charts, videos,
 * sound and SmartArt, which are counted, as are images the deck doesn't keep.
 * A slide's footer, number and date and an empty box are left out without
 * being counted, as the deck draws none, and so is a shape without words the
 * file marks as decorative, as PowerPoint marks one a screen reader passes
 * over, such as a section break's accent bar.
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
	const { slides } = await parse(file, { imageMode: "base64" });
	const shapes = await shapesOnSlides(file);
	const keep = imageKeeper(keepImage);
	let imagesLeftOut = 0;
	let othersLeftOut = 0;
	const deckSlides: Node[] = [];
	for (const [index, slide] of slides.entries()) {
		const read = readSlide(slide, shapes[index] ?? new Map(), schema);
		othersLeftOut += read.othersLeftOut;
		let contentLeftOut = read.contentLeftOut;
		const pieces: Piece<Node>[] = [];
		for (const piece of read.pieces) {
			if (piece.kind !== "image") {
				pieces.push(piece);
				continue;
			}
			const address = await keep(piece.image);
			if (address !== undefined) {
				pieces.push({ ...piece, image: imageNode(address, piece.image.words, schema) });
				continue;
			}
			imagesLeftOut++;
			contentLeftOut = true;
		}
		const laid = laidOut(inReadingOrder(pieces), { first: index === 0, contentLeftOut }, schema);
		deckSlides.push(slideOf(laid, notesOf(slide.note, schema), schema));
	}
	// A deck holds a slide at least, as markdown that says nothing is an empty title slide.
	const deck = schema.topNodeType.create(
		null,
		deckSlides.length > 0 ? deckSlides : [newSlide(schema, "title")],
	);
	deck.check();
	return { deck, imagesLeftOut, othersLeftOut };
}

/** Where something sits on a slide, in points from its top left corner. */
interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** An image in the file: its bytes as a data URL, empty for one linked from outside the file, and its words. */
interface ImageInFile {
	dataUrl: string;
	words: string;
}

/** What a text box or a shape says. */
interface TextPiece {
	kind: "text";
	box: Box;
	blocks: Node[];
	/** The size of its largest type, in points, or 0 when the file gives none. */
	typeSize: number;
	/** Whether it is the slide's title placeholder. */
	titlePlaceholder: boolean;
}

/** Something on a slide the deck keeps, with its image as `Image`: as it is in the file, then once kept. */
type Piece<Image> =
	| TextPiece
	| { kind: "table"; box: Box; table: Node }
	| { kind: "image"; box: Box; image: Image };

/** What the file says of a shape that the library doesn't: the placeholder it is, if one, an image's words, and whether it only decorates the slide. */
interface ShapeInFile {
	placeholder: string | undefined;
	words: string | undefined;
	decorative: boolean;
}

/** Placeholders that say where a slide is, or when, rather than what it says. */
const DECORATIVE_PLACEHOLDERS = new Set(["ftr", "sldNum", "dt"]);

const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);

/**
 * What of a slide the deck keeps, with its images as they are in the file;
 * how many other things on it the deck has no place for; and whether any of
 * those is content, such as a chart, rather than a drawing.
 */
function readSlide(
	slide: SlideInFile,
	shapes: ReadonlyMap<string, ShapeInFile>,
	schema: Schema,
): { pieces: Piece<ImageInFile>[]; othersLeftOut: number; contentLeftOut: boolean } {
	const pieces: Piece<ImageInFile>[] = [];
	let othersLeftOut = 0;
	let contentLeftOut = false;
	for (const { element, box } of elementsOn(slide.elements)) {
		const read = readElement(element, box, shapes.get(element.id), schema);
		if (read === "decoration") continue;
		if (typeof read === "object") {
			pieces.push(read);
			continue;
		}
		othersLeftOut++;
		contentLeftOut ||= read === "content";
	}
	return { pieces, othersLeftOut, contentLeftOut };
}

/**
 * The slide's elements where they sit on it, a group's as the group places
 * them, the groups themselves left out. A group's turning and flipping are
 * not followed, as only the order they are read in depends on where they sit.
 */
function elementsOn(
	elements: readonly ElementOnSlide[],
	offset = { left: 0, top: 0 },
): { element: Exclude<ElementOnSlide, { type: "group" }>; box: Box }[] {
	return elements.flatMap((element) => {
		const box = {
			left: element.left + offset.left,
			top: element.top + offset.top,
			width: element.width,
			height: element.height,
		};
		return element.type === "group" ? elementsOn(element.elements, box) : [{ element, box }];
	});
}

/**
 * What the deck keeps of `element`: what it says, its table or its image.
 * Otherwise what is left out: `"decoration"`, not counted, for an empty box,
 * the slide's footer, number or date, or a shape without words marked as
 * decorative; `"drawing"` for another shape without words; and `"content"`
 * for a chart, a video, sound, SmartArt or an equation.
 */
function readElement(
	element: Exclude<ElementOnSlide, { type: "group" }>,
	box: Box,
	shape: ShapeInFile | undefined,
	schema: Schema,
): Piece<ImageInFile> | "decoration" | "drawing" | "content" {
	switch (element.type) {
		case "text":
		case "shape": {
			if (DECORATIVE_PLACEHOLDERS.has(shape?.placeholder ?? "")) return "decoration";
			const blocks = blocksOf(element.content, schema);
			if (blocks.length === 0) {
				return element.type === "shape" && !shape?.decorative ? "drawing" : "decoration";
			}
			return {
				kind: "text",
				box,
				blocks,
				typeSize: largestTypeIn(element.content),
				titlePlaceholder: TITLE_PLACEHOLDERS.has(shape?.placeholder ?? ""),
			};
		}
		case "table":
			return element.data.length > 0
				? { kind: "table", box, table: tableOf(element.data, schema) }
				: "decoration";
		case "image":
			return {
				kind: "image",
				box,
				image: { dataUrl: element.base64, words: shape?.words ?? "" },
			};
		default:
			return "content";
	}
}

/*
 * Laying a slide out. A PowerPoint slide is boxes placed anywhere; a deck's
 * is one of a few layouts, so each slide gets the one that best fits what it
 * holds, by the rules in `laidOut`.
 */

/** The most characters a line may have to be taken for a title, or a short line for a subtitle or whose words a quote is. */
const SHORT_LINE_CHARACTERS = 100;

/** How far two boxes side by side may overlap and still be taken for side by side, in points. */
const SIDE_BY_SIDE_OVERLAP_PT = 8;

/** A slide's layout, and the blocks of its frame, in the order the layout reads them. */
interface LaidOut {
	layout: SlideLayout;
	blocks: Node[];
}

/** A slide of `layout` holding `blocks`, made to fit it, with its notes. An empty one holds what a new slide of its layout does. */
function slideOf({ layout, blocks }: LaidOut, notes: Node, schema: Schema): Node {
	const body =
		blocks.length > 0 ? nodeOf(schema, SLIDE_BODY, blocks) : newSlide(schema, layout).child(0);
	return nodeOf(schema, SLIDE, [fitSlideBody(body, layout), notes], { layout });
}

/**
 * The layout a slide of `pieces`, in reading order, gets, and the blocks of
 * its frame, by the first of these that fits it:
 *
 * - Nothing: an empty slide, `title` when it is the first and `bullets`
 *   after.
 * - Only words that are plainly a quote (`quoteIn`): `quote`.
 * - A table: `table`.
 * - Only a title (`titleAmong`), or a title over a short paragraph or two,
 *   with no chart or other content left out beside them: `title` when it is
 *   the first slide, and `section` after.
 * - Things side by side (`sideBySide`): `image` when one side holds the
 *   slide's one image, with the words in the first column and the image in
 *   the second, and `columns` otherwise.
 * - Only an image: `image`, its first column empty.
 * - Anything else: `bullets`.
 *
 * The title is the frame's heading, first, but on a section break, where a
 * label may sit above it, everything stays in reading order. What a layout
 * has no place of its own for stays in its frame, in reading order.
 */
function laidOut(
	pieces: readonly Piece<Node>[],
	{ first, contentLeftOut }: { first: boolean; contentLeftOut: boolean },
	schema: Schema,
): LaidOut {
	if (pieces.length === 0) return { layout: first ? "title" : "bullets", blocks: [] };
	const quote = quoteIn(pieces);
	if (quote) {
		return {
			layout: "quote",
			blocks: [nodeOf(schema, "blockquote", quote.quote), ...quote.saidBy],
		};
	}
	const title = titleAmong(pieces);
	const rest = pieces.filter((piece) => piece !== title);
	const heading = (level: number) => (title ? [headingOf(title, level, schema)] : []);
	const flow = (level: number) => [...heading(level), ...rest.flatMap(blocksOfPiece)];
	if (rest.some((piece) => piece.kind === "table")) return { layout: "table", blocks: flow(2) };
	if (title && !contentLeftOut && holdsAtMostASubtitle(rest)) {
		if (first) return { layout: "title", blocks: flow(1) };
		return {
			layout: "section",
			blocks: pieces.flatMap((piece) => (piece === title ? heading(2) : blocksOfPiece(piece))),
		};
	}
	const images = rest.filter((piece) => piece.kind === "image");
	const sides = sideBySide(rest);
	if (sides) {
		const [left, right] = sides;
		if (images.length !== 1) {
			return {
				layout: "columns",
				blocks: [...heading(2), columnOf(left, schema), columnOf(right, schema)],
			};
		}
		const [words, image] = left.some((piece) => piece.kind === "image") ? [right, left] : sides;
		return {
			layout: "image",
			blocks: [...heading(2), columnOf(words, schema), columnOf(image, schema)],
		};
	}
	if (rest.length === 1 && images.length === 1) {
		return {
			layout: "image",
			blocks: [...heading(2), columnOf([], schema), columnOf(images, schema)],
		};
	}
	return { layout: "bullets", blocks: flow(2) };
}

/** `pieces` in the order they are read: from the top of the slide down, and from the left across. */
const inReadingOrder = <Image>(pieces: readonly Piece<Image>[]): Piece<Image>[] =>
	[...pieces].sort((one, other) => one.box.top - other.box.top || one.box.left - other.box.left);

/** Whether a slide holding a title holds nothing else but a short paragraph or two, a subtitle. */
function holdsAtMostASubtitle(rest: readonly Piece<Node>[]): boolean {
	const [subtitle, ...more] = rest;
	if (!subtitle) return true;
	return (
		more.length === 0 &&
		subtitle.kind === "text" &&
		subtitle.blocks.every((block) => block.type.name === "paragraph") &&
		subtitle.blocks.reduce((characters, block) => characters + block.textContent.length, 0) <=
			SHORT_LINE_CHARACTERS
	);
}

/**
 * The slide's title: the file's title placeholder, when it has words, or the
 * words most likely to be one: a single short paragraph, not a list, in
 * larger type than any other words on the slide. Two such paragraphs in the
 * same size, as headings over two columns are, are neither of them a title.
 */
function titleAmong(pieces: readonly Piece<Node>[]): TextPiece | undefined {
	const words = pieces.filter((piece) => piece.kind === "text");
	const placeholder = words.find((piece) => piece.titlePlaceholder);
	if (placeholder) return placeholder;
	const [largest, ...others] = [...words].sort((one, other) => other.typeSize - one.typeSize);
	if (!largest || !isShortParagraph(largest.blocks)) return undefined;
	return others.every((other) => other.typeSize < largest.typeSize) ? largest : undefined;
}

const isShortParagraph = (blocks: readonly Node[]) =>
	blocks.length === 1 &&
	blocks[0]?.type.name === "paragraph" &&
	blocks[0].textContent.length <= SHORT_LINE_CHARACTERS;

/** A paragraph in quotation marks, with nothing after the closing one but the sentence's end. */
const QUOTED = /^\s*["“‘«„「『][\s\S]*["”’»“」』][.!?…]?\s*$/;

/**
 * The quote a slide holds, when all it holds is words that are plainly one:
 * a single paragraph in quotation marks, alone or over one short paragraph,
 * whose words they are. Words merely set large or alone are not enough, as a
 * title is too.
 */
function quoteIn(pieces: readonly Piece<Node>[]): { quote: Node; saidBy: Node[] } | undefined {
	if (pieces.some((piece) => piece.kind !== "text")) return undefined;
	const [quote, saidBy, ...more] = pieces.flatMap((piece) =>
		piece.kind === "text" ? piece.blocks : [],
	);
	if (!quote || more.length > 0 || quote.type.name !== "paragraph") return undefined;
	if (!QUOTED.test(quote.textContent)) return undefined;
	if (!saidBy) return { quote, saidBy: [] };
	return isShortParagraph([saidBy]) ? { quote, saidBy: [saidBy] } : undefined;
}

/**
 * `pieces` as the two sides of the slide they sit on, left then right, each
 * in reading order: when a gap runs down between them that none crosses,
 * with what is on each side level with what is on the other. `undefined`
 * when there is no such gap, as when one is above another, or more than one,
 * as with three columns.
 */
function sideBySide<Image>(
	pieces: readonly Piece<Image>[],
): [Piece<Image>[], Piece<Image>[]] | undefined {
	const byLeft = [...pieces].sort((one, other) => one.box.left - other.box.left);
	const gaps = byLeft.flatMap((_piece, at) => {
		if (at === 0) return [];
		const rightEdge = Math.max(...byLeft.slice(0, at).map(({ box }) => box.left + box.width));
		const leftEdge = Math.min(...byLeft.slice(at).map(({ box }) => box.left));
		return rightEdge - SIDE_BY_SIDE_OVERLAP_PT <= leftEdge ? [at] : [];
	});
	const [gap, ...moreGaps] = gaps;
	if (gap === undefined || moreGaps.length > 0) return undefined;
	const [left, right] = [byLeft.slice(0, gap), byLeft.slice(gap)];
	const level = top(left) < bottom(right) && top(right) < bottom(left);
	return level ? [inReadingOrder(left), inReadingOrder(right)] : undefined;
}

const top = (pieces: readonly { box: Box }[]) => Math.min(...pieces.map(({ box }) => box.top));

const bottom = (pieces: readonly { box: Box }[]) =>
	Math.max(...pieces.map(({ box }) => box.top + box.height));

function blocksOfPiece(piece: Piece<Node>): Node[] {
	switch (piece.kind) {
		case "text":
			return piece.blocks;
		case "table":
			return [piece.table];
		case "image":
			return [nodeOf(piece.image.type.schema, "paragraph", piece.image)];
	}
}

const columnOf = (pieces: readonly Piece<Node>[], schema: Schema) =>
	nodeOf(schema, SLIDE_COLUMN, pieces.flatMap(blocksOfPiece));

/** The title's words as a heading of `level`, each of its lines after a break. */
const headingOf = (title: TextPiece, level: number, schema: Schema) =>
	nodeOf(schema, "heading", withoutBold(joinedLines(linesOf(title.blocks), schema)), { level });

/**
 * `inline` without bold. A heading and a table's header row are drawn bold,
 * and a file sets a title or a header bold for that alone, so it isn't kept
 * as a mark of its own there.
 */
const withoutBold = (inline: readonly Node[]) =>
	inline.map((node) => node.mark(node.marks.filter((mark) => mark.type.name !== "bold")));

const imageNode = (address: string, words: string, schema: Schema) =>
	nodeOf(schema, "image", undefined, { src: address, alt: words || null });

/*
 * Reading what a text box says. The library gives it as HTML: paragraphs and
 * lists, each run of text in a `span` styled as the file sets it, and a link
 * as an `a` within.
 */

/**
 * The paragraphs and lists `html` holds, nested at their levels, each run of
 * text with the marks the deck has for its style. A paragraph that says
 * nothing, and an empty item of a list, are left out.
 */
function blocksOf(html: string, schema: Schema): Node[] {
	return blocksIn(new DOMParser().parseFromString(html, "text/html").body, schema);
}

/** The elements that hold blocks, rather than sitting in a line of text. */
const BLOCK_ELEMENTS = new Set(["P", "DIV", "LI", "UL", "OL"]);

const isElement = (node: ChildNode): node is Element => node.nodeType === node.ELEMENT_NODE;

const isList = (element: Element) => element.tagName === "UL" || element.tagName === "OL";

/** The blocks of `parent`, words outside any paragraph in it making one of their own. */
function blocksIn(parent: Element, schema: Schema): Node[] {
	const blocks: Node[] = [];
	let words: ChildNode[] = [];
	const endWords = () => {
		const inline = words.flatMap((word) => inlineOf(word, [], schema));
		if (inline.some((node) => node.isText && node.text?.trim())) {
			blocks.push(nodeOf(schema, "paragraph", inline));
		}
		words = [];
	};
	for (const child of parent.childNodes) {
		if (!isElement(child) || !BLOCK_ELEMENTS.has(child.tagName)) {
			words.push(child);
			continue;
		}
		endWords();
		if (isList(child)) blocks.push(...listOf(child, schema));
		else blocks.push(...blocksIn(child, schema));
	}
	endWords();
	return blocks;
}

/**
 * The list `list` is, with each item's own list nested in it. A list the
 * library puts straight in another, for a level with no item above it, goes
 * in the item before it, or an empty one.
 */
function listOf(list: Element, schema: Schema): Node[] {
	const items: Node[][] = [];
	for (const child of list.children) {
		if (child.tagName === "LI") {
			const blocks = blocksIn(child, schema);
			if (blocks.length > 0) items.push(blocks);
		} else if (isList(child)) {
			const nested = listOf(child, schema);
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
		? [
				nodeOf(schema, "orderedList", listItems, {
					start: Number(list.getAttribute("start")) || 1,
				}),
			]
		: [nodeOf(schema, "bulletList", listItems)];
}

/** `node`, part of a line of text, as the deck's: its text with `marks` and those of what holds it, and a line break as one. */
function inlineOf(node: ChildNode, marks: readonly Mark[], schema: Schema): Node[] {
	if (node.nodeType === node.TEXT_NODE) return textOf(node.textContent ?? "", marks, schema);
	if (!isElement(node)) return [];
	if (node.tagName === "BR") return [nodeOf(schema, "hardBreak")];
	const within = marksOf(node, marks, schema);
	return [...node.childNodes].flatMap((child) => inlineOf(child, within, schema));
}

/**
 * `text` with `marks`, each line break in it a break of the line. A link is
 * drawn underlined, and the file underlines it for that alone, so its
 * underline isn't kept as a mark of its own.
 */
function textOf(text: string, marks: readonly Mark[], schema: Schema): Node[] {
	const linked = marks.some((mark) => mark.type.name === "link");
	const kept = linked ? marks.filter((mark) => mark.type.name !== "underline") : marks;
	return text
		.split(LINE_BREAK)
		.flatMap((line, index) => [
			...(index > 0 ? [nodeOf(schema, "hardBreak")] : []),
			...(line === "" ? [] : [schema.text(line, kept)]),
		]);
}

const LINE_BREAK = /\r\n|\r|\n/;

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

/** `marks` with those `element` adds: the ones its style says, and a link where a link may go. */
function marksOf(element: Element, marks: readonly Mark[], schema: Schema): readonly Mark[] {
	const style = styleOf(element);
	const href = element.tagName === "A" ? element.getAttribute("href") : null;
	const added = [
		...Object.entries(MARKS_OF_STYLES).flatMap(([name, says]) =>
			says(style) ? [schema.marks[name]?.create()] : [],
		),
		...(href && linkMayGoTo(href) ? [schema.marks.link?.create({ href })] : []),
	];
	return added.reduce<readonly Mark[]>((set, mark) => (mark ? mark.addToSet(set) : set), marks);
}

/** An element's inline style, by property. */
function styleOf(element: Element): Record<string, string> {
	const declarations = (element.getAttribute("style") ?? "").matchAll(/([\w-]+)\s*:\s*([^;]*)/g);
	return Object.fromEntries(
		[...declarations].map(([, property = "", value = ""]) => [property, value.trim()]),
	);
}

/** The size of the largest type in `html`, in points, or 0 when it sets none. */
function largestTypeIn(html: string): number {
	const sizes = [...html.matchAll(/font-size:\s*([\d.]+)pt/g)].map(([, size]) => Number(size));
	return Math.max(0, ...sizes);
}

/** Each line of `blocks`, its paragraphs' and its lists' items' alike, as its inline content. */
const linesOf = (blocks: readonly Node[]): Fragment[] =>
	blocks.flatMap((block) => (block.isTextblock ? [block.content] : linesOf(block.children)));

/** `lines` as the inline content of one line, a break between each two. */
function joinedLines(lines: readonly Fragment[], schema: Schema): Node[] {
	return lines.flatMap((line, index) => [
		...(index > 0 ? [nodeOf(schema, "hardBreak")] : []),
		...line.content,
	]);
}

/**
 * A table of the cells' words, the first row its header row, as the deck
 * keeps tables as markdown, whose tables all have one. A cell's paragraphs
 * and items are its lines. A merged cell's words are in the first of the
 * cells it spans, and the rest are empty, so no words are lost; a row with
 * fewer cells than the widest is made as wide with empty ones.
 */
function tableOf(rows: readonly (readonly TableCell[])[], schema: Schema): Node {
	const width = Math.max(1, ...rows.map((row) => row.length));
	const cellOf = (cell: TableCell | undefined, header: boolean) => {
		const words = joinedLines(linesOf(blocksOf(cell?.text ?? "", schema)), schema);
		return nodeOf(schema, header ? "tableHeader" : "tableCell", [
			nodeOf(schema, "paragraph", header ? withoutBold(words) : words),
		]);
	};
	return nodeOf(
		schema,
		"table",
		rows.map((row, rowIndex) =>
			nodeOf(
				schema,
				"tableRow",
				Array.from({ length: width }, (_cell, column) => cellOf(row[column], rowIndex === 0)),
			),
		),
	);
}

/**
 * A slide's notes as the deck's: plain paragraphs, a line each, with the
 * marks they have. An empty line is left out.
 */
function notesOf(html: string, schema: Schema): Node {
	const lines = linesOf(blocksOf(html, schema)).flatMap((line) => {
		const split: Node[][] = [[]];
		line.forEach((inline) => {
			if (inline.type.name === "hardBreak") split.push([]);
			else split.at(-1)?.push(inline);
		});
		return split.filter((words) => words.some((word) => word.text?.trim()));
	});
	const paragraphs = lines.map((words) => nodeOf(schema, "paragraph", words));
	return nodeOf(
		schema,
		SPEAKER_NOTES,
		paragraphs.length > 0 ? paragraphs : [nodeOf(schema, "paragraph")],
	);
}

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

/** The bytes in a data URL, or `undefined` for none, or for one that isn't base64. */
function bytesOf(dataUrl: string): Uint8Array | undefined {
	const comma = dataUrl.indexOf(",");
	if (!dataUrl.startsWith("data:") || comma < 0) return undefined;
	try {
		return Uint8Array.from(atob(dataUrl.slice(comma + 1)), (character) => character.charCodeAt(0));
	} catch {
		return undefined;
	}
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
 * read so, whose slides are then laid out without it.
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
					words: properties.getAttribute("descr") ?? undefined,
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

function nodeOf(
	schema: Schema,
	name: string,
	content?: Node | readonly Node[],
	attributes?: Record<string, unknown>,
): Node {
	const type = schema.nodes[name];
	if (!type) throw new Error(`The schema has no ${name} node`);
	return type.create(attributes ?? null, content);
}
