import {
	type Artifact,
	type ArtifactImageType,
	MAX_ARTIFACT_IMAGES_BYTES,
} from "@sugabots/contracts";
import { type ArtifactImageIds, ownImageAt } from "@sugabots/contracts/http";
import { linkMayGoTo } from "@sugabots/contracts/live-document";
import { liveDocumentFromMarkdown } from "@sugabots/contracts/live-document-markdown";
import { layoutOf, SLIDE_BODY, SLIDE_COLUMN, SPEAKER_NOTES } from "@sugabots/contracts/live-slides";
import { SLIDE_LAYOUTS, type SlideLayout } from "@sugabots/contracts/slides-markdown";
import { Fragment, type Mark, type Node } from "@tiptap/pm/model";
import { Effect } from "effect";
import { imageSize } from "image-size";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";

/** The media type of a .pptx file. */
export const POWERPOINT_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** An image for the PowerPoint file to hold: its bytes, and their media type. */
export interface PowerPointImage {
	contentType: ArtifactImageType;
	bytes: Uint8Array;
}

/**
 * A `slides` deck's markdown as a PowerPoint file titled as the artifact is,
 * 16:9, a slide for each of the deck's in order. Each of the deck's layouts
 * is a layout of the file's, named as the app names it and laid out as the
 * app draws it, in light colours and Arial, and each slide's title and text
 * are in its layout's placeholders. Text keeps its bold, italics, underline,
 * strikethrough, superscript, subscript, highlight, inline code and links,
 * lists are PowerPoint's own at their depth, and a slide's speaker notes are
 * its notes. A table is PowerPoint's own. An image the deck keeps is held in
 * the file, as `imageOf` gives it, with its words, when it is a PNG, JPEG or
 * GIF; any other image comes out as its words. A quote is its paragraphs in
 * grey italics, and a code block its lines in a monospace font.
 *
 * Whatever a layout has no place for, such as a table on a title slide, is
 * stacked with the rest of what its region holds, in text boxes of its own,
 * so nothing the deck holds is left out. Text longer than its box is set to
 * shrink on overflow, which PowerPoint works out when the text is next edited.
 */
export const powerPointFileOf = <E, R>(
	artifact: Pick<Artifact, "podId" | "id" | "title">,
	markdown: string,
	imageOf: (image: ArtifactImageIds) => Effect.Effect<PowerPointImage | undefined, E, R>,
): Effect.Effect<Uint8Array, E, R> =>
	Effect.gen(function* () {
		const deck = liveDocumentFromMarkdown("slides", markdown);
		const own = ownImagesIn(deck, { podId: artifact.podId, artifactId: artifact.id });
		const found = yield* Effect.forEach(own, ([address, ids]) =>
			Effect.map(imageOf(ids), (image) => [address, image && drawable(image)] as const),
		);
		const drawn = new Map(
			found.flatMap(([address, image]) => (image ? [[address, image] as const] : [])),
		);
		const { presentation, slides } = presentationOf(artifact.title, deck, imageDrawer(drawn));
		return yield* Effect.promise(async () =>
			withPowerPointsOwnForms(await presentation.write({ outputType: "uint8array" }), slides),
		);
	});

/** The images in the deck that `artifact` keeps, once each, by address. */
function ownImagesIn(
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

/*
 * Positions and sizes are in points. The mock-ups the layouts follow draw a
 * slide 960px wide, which on PowerPoint's 13.33in-wide 16:9 slide is a point
 * to a pixel, with an em of 16px.
 */

const EM = 16;
const POINTS_PER_INCH = 72;
const SLIDE_WIDTH = 60 * EM;
const SLIDE_HEIGHT = 33.75 * EM;
const PADDING_X = 5 * EM;
const PADDING_Y = 4 * EM;
const CONTENT_WIDTH = SLIDE_WIDTH - 2 * PADDING_X;
const CONTENT_BOTTOM = SLIDE_HEIGHT - PADDING_Y;
const COLUMN_GAP = 3.5 * EM;
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP) / 2;
const SECOND_COLUMN_X = PADDING_X + COLUMN_WIDTH + COLUMN_GAP;

/** The mock-ups' light colours: a deck holds no theme, and a file to hand on is light. */
const BACKGROUND = "FFFFFF";
const TEXT = "111113";
const SECONDARY = "52525B";
const ACCENT = "2563EB";
const RULE = "E4E4E7";
const TINT = "F4F4F5";

/** Fonts every copy of PowerPoint has, which the app's own isn't. */
const FONT = "Arial";
const CODE_FONT = "Courier New";

/** The yellow a highlight is, PowerPoint's own highlighter colour. */
const HIGHLIGHT_YELLOW = "FFFF00";

/**
 * The height of a line of Arial at 100% line spacing, as a multiple of its
 * size, which PowerPoint's line spacing is a share of, as CSS's isn't.
 */
const ARIAL_LINE_HEIGHT = 1.15;

/** The space between a bullet and its text, and between levels, in ems of the text, as the mock-ups indent a list. */
const BULLET_INDENT_EM = 1.2;

/** The bullets of each level of a list, as a browser draws them. */
const BULLET_CHARACTERS = ["2022", "25E6", "25AA"];

/** A code block's size, as a share of the text around it. */
const CODE_SCALE = 0.8;

/** How a region's text looks. */
interface TextStyle {
	/** In points. */
	size: number;
	color: string;
	bold?: boolean;
	italic?: boolean;
	/** As the mock-ups' CSS gives it: a multiple of the size. */
	lineHeight: number;
	/** The space after each paragraph, in points. */
	gap: number;
	/** How much larger than its text each level of heading in it is: no larger in a title. */
	headingScale: Readonly<Record<number, number>>;
}

const NO_HEADING_SCALE = {};
const BODY_HEADING_SCALE = { 1: 1.6, 2: 1.35, 3: 1.1 };

/** A heading on a slide (an `h2` of 2.5em, weight 600) and the text below it (1.5em). */
const SLIDE_TITLE: TextStyle = {
	size: 2.5 * EM,
	color: TEXT,
	bold: true,
	lineHeight: 1.15,
	gap: 0,
	headingScale: NO_HEADING_SCALE,
};
const SLIDE_TEXT: TextStyle = {
	size: 1.5 * EM,
	color: TEXT,
	lineHeight: 1.4,
	gap: 0.7 * 1.5 * EM,
	headingScale: BODY_HEADING_SCALE,
};

/** A column's text (1.25em), whose heading is an `h3` of 1.375em. */
const COLUMN_TEXT: TextStyle = {
	...SLIDE_TEXT,
	size: 1.25 * EM,
	gap: 0.6 * 1.25 * EM,
};

/** The small grey text under a section break's title, and under a quote, saying whose it is (1.25em). */
const CAPTION_TEXT: TextStyle = {
	...SLIDE_TEXT,
	size: 1.25 * EM,
	color: SECONDARY,
	gap: 0.5 * EM,
};

/** A table's text (1.25em), and its header row's, bold and grey on a tint. */
const TABLE_TEXT: TextStyle = {
	size: 1.25 * EM,
	color: TEXT,
	lineHeight: 1.35,
	gap: 0,
	headingScale: NO_HEADING_SCALE,
};
const TABLE_HEADER_TEXT: TextStyle = { ...TABLE_TEXT, color: SECONDARY, bold: true };

/** The padding of a table's header cells and other cells: 0.6em and 0.7em, by 0.8em, of its text. */
const HEADER_CELL_PADDING = { y: 0.6 * TABLE_TEXT.size, x: 0.8 * TABLE_TEXT.size };
const CELL_PADDING = { y: 0.7 * TABLE_TEXT.size, x: 0.8 * TABLE_TEXT.size };

/** A quote within other text: grey italics. */
const QUOTED = { color: SECONDARY, italic: true };

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** What a slide holds, as its layout places it. */
interface SlideBlocks {
	/** Its first block when that is a heading: its title. */
	title: readonly Node[];
	/** Its other blocks outside columns, in order. */
	flow: readonly Node[];
	/** What each of its two columns holds, in a layout with columns. */
	columns: readonly [readonly Node[], readonly Node[]];
}

/** A part of a layout, which is a placeholder of the file's. */
interface Region {
	/** Its placeholder's name, by which a slide's text for it is put in it. */
	name: string;
	/** What PowerPoint takes it for: the slide's title, or its text. */
	type: "title" | "body";
	/** What it shows when empty on a slide made in PowerPoint. */
	prompt: string;
	box: Box;
	/** The edge of its box its text sits against. */
	anchor: "top" | "bottom";
	text: TextStyle;
	/** What a slide holds in it. */
	holds: (blocks: SlideBlocks) => readonly Node[];
}

/** One of the deck's layouts as a layout of the file's. */
interface LayoutDesign {
	/** Its name in PowerPoint's Layout menu, as the app's layout picker names it. */
	name: string;
	regions: readonly Region[];
	/** The section break's accent bar, which every slide of the layout shows. */
	bar?: Box;
}

const everyBlock = ({ title, flow, columns }: SlideBlocks) => [
	...title,
	...flow,
	...columns.flat(),
];

const titleOf = ({ title }: SlideBlocks) => title;

/** Everything but the title, as one flow. */
const allButTitle = ({ flow, columns }: SlideBlocks) => [...flow, ...columns.flat()];

/**
 * A quote slide's first block, its quote, and what follows, whose words
 * they are. A quote's own blocks are the quote, unquoted, as the slide's
 * large text sets it apart already.
 */
function quoteAndRest(blocks: SlideBlocks): { quote: readonly Node[]; rest: readonly Node[] } {
	const [first, ...rest] = everyBlock(blocks);
	if (!first) return { quote: [], rest };
	return { quote: first.type.name === "blockquote" ? first.children : [first], rest };
}

const titleRegion = (box: Box, anchor: Region["anchor"], text = SLIDE_TITLE): Region => ({
	name: "title",
	type: "title",
	prompt: "Title",
	box,
	anchor,
	text,
	holds: titleOf,
});

/** Under a slide's heading, with the mock-ups' 2em between them. */
const UNDER_TITLE_Y = PADDING_Y + SLIDE_TITLE.size * SLIDE_TITLE.lineHeight + 2 * EM;

const TOP_TITLE = titleRegion(
	{
		x: PADDING_X,
		y: PADDING_Y,
		w: CONTENT_WIDTH,
		h: SLIDE_TITLE.size * SLIDE_TITLE.lineHeight,
	},
	"top",
);

/** The middle of the space within the padding, which the title and image layouts centre on. */
const MIDDLE_Y = (PADDING_Y + CONTENT_BOTTOM) / 2;

/** Half the gap between a centred title and the text under it, 1.25em. */
const HALF_CENTRED_GAP = 0.625 * EM;

/** Above the middle, for a title centred with its text, and below it, for the text. */
const ABOVE_MIDDLE = { y: PADDING_Y, h: MIDDLE_Y - HALF_CENTRED_GAP - PADDING_Y };
const BELOW_MIDDLE = {
	y: MIDDLE_Y + HALF_CENTRED_GAP,
	h: CONTENT_BOTTOM - MIDDLE_Y - HALF_CENTRED_GAP,
};

/**
 * The section break's title (4em, weight 700), whose box holds two lines and
 * sits on the text below it (1.25em), at the bottom, under the accent bar,
 * 1em apart each. A box holds the same space whatever it holds, so a title of
 * one line sits that much lower under the bar than the mock-up draws it.
 */
const SECTION_TITLE: TextStyle = { ...SLIDE_TITLE, size: 4 * EM, lineHeight: 1.05 };
const SECTION_TEXT_HEIGHT = 2 * CAPTION_TEXT.size * CAPTION_TEXT.lineHeight;
const SECTION_TITLE_HEIGHT = 2 * SECTION_TITLE.size * SECTION_TITLE.lineHeight;
const SECTION_TEXT_Y = CONTENT_BOTTOM - SECTION_TEXT_HEIGHT;
const SECTION_TITLE_Y = SECTION_TEXT_Y - EM - SECTION_TITLE_HEIGHT;
const SECTION_BAR = { w: 3 * EM, h: 0.3 * EM };

/** The quote layout's wider padding (7em), its quote (2.5em, weight 500), and whose words they are (1.25em), 1.75em below. */
const QUOTE_X = 7 * EM;
const QUOTE_WIDTH = SLIDE_WIDTH - 2 * QUOTE_X;
const QUOTE_TEXT: TextStyle = {
	size: 2.5 * EM,
	color: TEXT,
	lineHeight: 1.25,
	gap: EM,
	headingScale: NO_HEADING_SCALE,
};
/** Where the quote ends, so a quote of three lines and its attribution are centred on the slide. */
const QUOTE_BOTTOM = 20 * EM;
const ATTRIBUTION_Y = QUOTE_BOTTOM + 1.75 * EM;

/** Each of the deck's layouts as the file lays it out, after the mock-ups the app draws. */
const LAYOUTS: Readonly<Record<SlideLayout, LayoutDesign>> = {
	title: {
		name: "Title",
		regions: [
			titleRegion({ x: PADDING_X, w: CONTENT_WIDTH, ...ABOVE_MIDDLE }, "bottom", {
				...SLIDE_TITLE,
				size: 3.75 * EM,
				lineHeight: 1.1,
			}),
			{
				name: "subtitle",
				type: "body",
				prompt: "Subtitle",
				box: { x: PADDING_X, w: CONTENT_WIDTH, ...BELOW_MIDDLE },
				anchor: "top",
				text: { ...SLIDE_TEXT, color: SECONDARY, gap: 0.5 * EM },
				holds: allButTitle,
			},
		],
	},
	bullets: {
		name: "Title and bullets",
		regions: [
			TOP_TITLE,
			{
				name: "body",
				type: "body",
				prompt: "Text",
				box: {
					x: PADDING_X,
					y: UNDER_TITLE_Y,
					w: CONTENT_WIDTH,
					h: CONTENT_BOTTOM - UNDER_TITLE_Y,
				},
				anchor: "top",
				text: SLIDE_TEXT,
				holds: allButTitle,
			},
		],
	},
	columns: {
		name: "Two columns",
		regions: [
			TOP_TITLE,
			{
				name: "left",
				type: "body",
				prompt: "Left column",
				box: { x: PADDING_X, y: UNDER_TITLE_Y, w: COLUMN_WIDTH, h: CONTENT_BOTTOM - UNDER_TITLE_Y },
				anchor: "top",
				text: COLUMN_TEXT,
				holds: ({ flow, columns }) => [...flow, ...columns[0]],
			},
			{
				name: "right",
				type: "body",
				prompt: "Right column",
				box: {
					x: SECOND_COLUMN_X,
					y: UNDER_TITLE_Y,
					w: COLUMN_WIDTH,
					h: CONTENT_BOTTOM - UNDER_TITLE_Y,
				},
				anchor: "top",
				text: COLUMN_TEXT,
				holds: ({ columns }) => columns[1],
			},
		],
	},
	image: {
		name: "Image and text",
		regions: [
			titleRegion({ x: PADDING_X, w: COLUMN_WIDTH, ...ABOVE_MIDDLE }, "bottom"),
			{
				name: "text",
				type: "body",
				prompt: "Text",
				box: { x: PADDING_X, w: COLUMN_WIDTH, ...BELOW_MIDDLE },
				anchor: "top",
				text: { ...SLIDE_TEXT, size: 1.375 * EM, color: SECONDARY, lineHeight: 1.5, gap: 0.5 * EM },
				holds: ({ flow, columns }) => [...flow, ...columns[0]],
			},
			{
				name: "image",
				type: "body",
				prompt: "Image",
				box: {
					x: SECOND_COLUMN_X,
					y: PADDING_Y,
					w: COLUMN_WIDTH,
					h: CONTENT_BOTTOM - PADDING_Y,
				},
				anchor: "top",
				text: COLUMN_TEXT,
				holds: ({ columns }) => columns[1],
			},
		],
	},
	section: {
		name: "Section break",
		regions: [
			titleRegion(
				{ x: PADDING_X, y: SECTION_TITLE_Y, w: CONTENT_WIDTH, h: SECTION_TITLE_HEIGHT },
				"bottom",
				SECTION_TITLE,
			),
			{
				name: "body",
				type: "body",
				prompt: "Text",
				box: { x: PADDING_X, y: SECTION_TEXT_Y, w: CONTENT_WIDTH, h: SECTION_TEXT_HEIGHT },
				anchor: "top",
				text: CAPTION_TEXT,
				holds: allButTitle,
			},
		],
		bar: {
			x: PADDING_X,
			y: SECTION_TITLE_Y - EM - SECTION_BAR.h,
			...SECTION_BAR,
		},
	},
	quote: {
		name: "Quote",
		regions: [
			{
				name: "quote",
				// The slide's title, as PowerPoint's own quote layouts have it, for an outline and a screen reader.
				type: "title",
				prompt: "Quote",
				box: { x: QUOTE_X, y: PADDING_Y, w: QUOTE_WIDTH, h: QUOTE_BOTTOM - PADDING_Y },
				anchor: "bottom",
				text: QUOTE_TEXT,
				holds: (blocks) => quoteAndRest(blocks).quote,
			},
			{
				name: "attribution",
				type: "body",
				prompt: "Who said it",
				box: { x: QUOTE_X, y: ATTRIBUTION_Y, w: QUOTE_WIDTH, h: CONTENT_BOTTOM - ATTRIBUTION_Y },
				anchor: "top",
				text: CAPTION_TEXT,
				holds: (blocks) => quoteAndRest(blocks).rest,
			},
		],
	},
	table: {
		name: "Table",
		regions: [
			TOP_TITLE,
			{
				name: "table",
				type: "body",
				prompt: "Table",
				box: {
					x: PADDING_X,
					y: UNDER_TITLE_Y,
					w: CONTENT_WIDTH,
					h: CONTENT_BOTTOM - UNDER_TITLE_Y,
				},
				anchor: "top",
				text: COLUMN_TEXT,
				holds: allButTitle,
			},
		],
	},
};

/**
 * PptxGenJS numbers a layout's placeholders from 100, in the order they are
 * defined, which the regions are first in.
 */
const FIRST_PLACEHOLDER_INDEX = 100;

/** An image the file can hold: as PptxGenJS takes it, with its size in pixels. */
interface DrawableImage {
	data: string;
	width: number;
	height: number;
	byteLength: number;
}

/**
 * The kinds of image every PowerPoint draws. Older copies show no WebP, and
 * a file is handed on to whatever copy its reader has.
 */
const DRAWN_TYPES: ReadonlySet<ArtifactImageType> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
]);

/** `image` as the file can hold it: `undefined` when PowerPoint wouldn't draw it, or it can't be read as the image it says it is. */
function drawable({ contentType, bytes }: PowerPointImage): DrawableImage | undefined {
	if (!DRAWN_TYPES.has(contentType)) return undefined;
	const size = sizeOf(bytes);
	if (!size) return undefined;
	return {
		data: `${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
		...size,
		byteLength: bytes.byteLength,
	};
}

function sizeOf(bytes: Uint8Array): { width: number; height: number } | undefined {
	try {
		const { width, height } = imageSize(bytes);
		return width && height ? { width, height } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Draws the image at an address, when it is one the file holds, or gives
 * `undefined` for its words instead. Each drawing counts against the most a
 * deck keeps of images, so an image placed many times can't make the file
 * hold more than that.
 */
type ImageDrawer = (address: unknown) => DrawableImage | undefined;

function imageDrawer(drawn: ReadonlyMap<string, DrawableImage>): ImageDrawer {
	let bytesLeft = MAX_ARTIFACT_IMAGES_BYTES;
	return (address) => {
		const image = typeof address === "string" ? drawn.get(address) : undefined;
		if (!image || image.byteLength > bytesLeft) return undefined;
		bytesLeft -= image.byteLength;
		return image;
	};
}

/** What the file's own forms need to know of each slide once PptxGenJS has written it. */
interface DrawnSlide {
	/** Its speaker notes' paragraphs. */
	notes: readonly Node[];
	/** The placeholders it leaves empty because what their region holds is stacked in boxes of its own. */
	stacked: readonly number[];
}

/*
 * PptxGenJS writes a slide only from what it is given, and fetches an image
 * only when given its path: it is only ever given images' bytes here, so a
 * deck, which the pod's bots and people write, can't make the API fetch
 * anything.
 */
function presentationOf(
	title: string,
	deck: Node,
	draw: ImageDrawer,
): { presentation: PptxGenJS; slides: DrawnSlide[] } {
	const presentation = new PptxGenJS();
	presentation.layout = "LAYOUT_WIDE";
	presentation.title = title;
	presentation.author = "";
	presentation.company = "";
	presentation.subject = "";
	presentation.theme = { headFontFace: FONT, bodyFontFace: FONT };
	for (const layout of SLIDE_LAYOUTS) presentation.defineSlideMaster(masterOf(LAYOUTS[layout]));
	const slides = deck.children.map((slide) => addSlide(presentation, slide, draw));
	return { presentation, slides };
}

function masterOf({ name, regions, bar }: LayoutDesign): PptxGenJS.SlideMasterProps {
	return {
		title: name,
		background: { color: BACKGROUND },
		objects: [
			...regions.map((region) => ({
				placeholder: { options: placeholderOptions(region), text: region.prompt },
			})),
			...(bar ? [{ rect: { ...inchesOf(bar), fill: { color: ACCENT } } }] : []),
		],
	};
}

/**
 * A region as a placeholder: its box and its text's look, which a slide's
 * text for it takes too, and which a slide made in PowerPoint from the layout
 * starts with.
 */
function placeholderOptions(region: Region): PptxGenJS.PlaceholderProps {
	const options: PptxGenJS.PlaceholderProps &
		Pick<PptxGenJS.TextPropsOptions, "lineSpacingMultiple" | "paraSpaceAfter"> = {
		name: region.name,
		type: region.type,
		...inchesOf(region.box),
		...textOptions(region.text),
		valign: region.anchor,
		margin: 0,
	};
	return options;
}

function addSlide(presentation: PptxGenJS, slide: Node, draw: ImageDrawer): DrawnSlide {
	const design = LAYOUTS[layoutOf(slide)];
	const added = presentation.addSlide({ masterName: design.name });
	const blocks = slideBlocksOf(childNamed(slide, SLIDE_BODY));
	const stacked = design.regions.flatMap((region, index) => {
		const held = region.holds(blocks);
		const parts = held.every(isEmptyParagraph) ? [] : partsOf(held, draw);
		const [first] = parts;
		if (!first) return [];
		if (parts.length === 1 && first.kind === "text") {
			added.addText(textOf(paragraphsIn(first.blocks, region.text)), {
				placeholder: region.name,
				fit: "shrink",
			});
			return [];
		}
		stack(added, region, parts);
		return [FIRST_PLACEHOLDER_INDEX + index];
	});
	return { notes: childNamed(slide, SPEAKER_NOTES).children, stacked };
}

function childNamed(node: Node, name: string): Node {
	const child = node.children.find((each) => each.type.name === name);
	if (!child) throw new Error(`A slide holds no ${name}`);
	return child;
}

const isColumn = (block: Node) => block.type.name === SLIDE_COLUMN;

const isEmptyParagraph = (block: Node) => block.type.name === "paragraph" && block.childCount === 0;

/** A slide's frame as its layouts place it. A third column or more, which a frame fitted to its layout holds none of, goes in the second. */
function slideBlocksOf(body: Node): SlideBlocks {
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

/** What a region holds, as the file draws it: text, a table, or an image. */
type Part =
	| { kind: "text"; blocks: readonly Node[] }
	| { kind: "table"; table: Node }
	| { kind: "image"; image: DrawableImage; words: string; link: unknown };

/**
 * `blocks` as parts, one after another. A paragraph's images that the file
 * holds stand on their own, between the words before and after them, as an
 * image can't sit in a line of PowerPoint's text.
 */
function partsOf(blocks: readonly Node[], draw: ImageDrawer): Part[] {
	const parts: Part[] = [];
	for (const part of blocks.flatMap((block) => blockParts(block, draw))) {
		const last = parts.at(-1);
		if (part.kind === "text" && last?.kind === "text") {
			parts[parts.length - 1] = { kind: "text", blocks: [...last.blocks, ...part.blocks] };
		} else {
			parts.push(part);
		}
	}
	return parts;
}

function blockParts(block: Node, draw: ImageDrawer): Part[] {
	if (block.type.name === "table") return [{ kind: "table", table: block }];
	if (block.type.name !== "paragraph" || !holdsImage(block)) {
		return [{ kind: "text", blocks: [block] }];
	}
	return paragraphParts(block, draw);
}

const holdsImage = (paragraph: Node) =>
	paragraph.children.some((child) => child.type.name === "image");

function paragraphParts(paragraph: Node, draw: ImageDrawer): Part[] {
	const parts: Part[] = [];
	let words: Node[] = [];
	const endWords = () => {
		if (words.some(saysSomething)) {
			parts.push({ kind: "text", blocks: [paragraph.copy(Fragment.fromArray(words))] });
		}
		words = [];
	};
	for (const child of paragraph.children) {
		const image = child.type.name === "image" ? draw(child.attrs.src) : undefined;
		if (!image) {
			words.push(child);
			continue;
		}
		endWords();
		parts.push({
			kind: "image",
			image,
			words: String(child.attrs.alt ?? ""),
			link: child.attrs.link,
		});
	}
	endWords();
	return parts;
}

/** Whether a piece of a line shows anything: words, or an image's words. */
const saysSomething = (inline: Node) =>
	inline.type.name === "image" ? Boolean(inline.attrs.alt) : inline.textContent.trim() !== "";

/** The space between parts stacked in a region. */
const STACK_GAP = EM;

/** The most of a region text and tables take beside an image, which has the rest. */
const MOST_BESIDE_IMAGES = 0.6;

/** The average width of a character of Arial, in ems, for how many lines a paragraph takes. */
const AVERAGE_CHARACTER_WIDTH = 0.5;

/**
 * Stacks a region's parts down its box: text and tables as tall as they will
 * likely be, which is guessed, and images sharing what is left, each as large
 * as fits without being enlarged. Text that runs longer than its box is set
 * to shrink, as in a placeholder.
 */
function stack(slide: PptxGenJS.Slide, region: Region, parts: readonly Part[]) {
	const heights = stackedHeights(region, parts);
	let y = region.box.y;
	parts.forEach((part, index) => {
		const slot = { ...region.box, y, h: heights[index] ?? 0 };
		y += slot.h + STACK_GAP;
		if (part.kind === "text") {
			slide.addText(textOf(paragraphsIn(part.blocks, region.text)), {
				...inchesOf(slot),
				...textOptions(region.text),
				valign: "top",
				margin: 0,
				fit: "shrink",
				isTextBox: true,
			});
			return;
		}
		if (part.kind === "table") {
			slide.addTable(tableRowsOf(part.table), tableOptions(part.table, slot));
			return;
		}
		slide.addImage({
			data: part.image.data,
			...inchesOf(fitted(part.image, slot)),
			altText: part.words,
			...linkTo(part.link),
		});
	});
}

function stackedHeights(region: Region, parts: readonly Part[]): number[] {
	const available = region.box.h - STACK_GAP * (parts.length - 1);
	const wanted = parts.map((part) => likelyHeight(part, region));
	const fixed = wanted.reduce<number>((total, height) => total + (height ?? 0), 0);
	const images = wanted.filter((height) => height === undefined).length;
	const room = images === 0 ? available : available * MOST_BESIDE_IMAGES;
	const scale = fixed > room ? room / fixed : 1;
	const imageHeight = images === 0 ? 0 : (available - fixed * scale) / images;
	return wanted.map((height) => (height === undefined ? imageHeight : height * scale));
}

/** How tall a part will likely be, in points: `undefined` for an image, which takes what is left. */
function likelyHeight(part: Part, { text, box }: Region): number | undefined {
	if (part.kind === "image") return undefined;
	if (part.kind === "table") {
		const rows = part.table.childCount;
		const lines = rows * TABLE_TEXT.size * TABLE_TEXT.lineHeight;
		return lines + 2 * HEADER_CELL_PADDING.y + 2 * CELL_PADDING.y * (rows - 1);
	}
	return paragraphsIn(part.blocks, text).reduce((total, { runs }) => {
		const size = Math.max(text.size, ...runs.map(({ options }) => options?.fontSize ?? 0));
		const characters = runs.reduce((count, run) => count + (run.text?.length ?? 0), 0);
		const perLine = Math.max(1, Math.floor(box.w / (size * AVERAGE_CHARACTER_WIDTH)));
		const breaks = runs.filter(({ options }) => options?.softBreakBefore).length;
		const lines = Math.max(1, Math.ceil(characters / perLine)) + breaks;
		return total + lines * size * text.lineHeight + text.gap;
	}, 0);
}

/** `image` as large as fits in `slot`, but no larger than it is, a pixel to a point, and centred in it. */
function fitted(image: DrawableImage, slot: Box): Box {
	const scale = Math.min(1, slot.w / image.width, slot.h / image.height);
	const w = image.width * scale;
	const h = image.height * scale;
	return { x: slot.x + (slot.w - w) / 2, y: slot.y + (slot.h - h) / 2, w, h };
}

const inchesOf = ({ x, y, w, h }: Box) => ({
	x: x / POINTS_PER_INCH,
	y: y / POINTS_PER_INCH,
	w: w / POINTS_PER_INCH,
	h: h / POINTS_PER_INCH,
});

/** A table as PowerPoint's own, across `slot`, its columns as wide as each other, its rows as tall as their text. */
function tableOptions(table: Node, slot: Box): PptxGenJS.TableProps {
	const columns = Math.max(1, ...table.children.map((row) => row.childCount));
	const { x, y, w } = inchesOf(slot);
	return {
		x,
		y,
		w,
		colW: Array.from({ length: columns }, () => w / columns),
		...textOptions(TABLE_TEXT),
		valign: "top",
		autoPage: false,
	};
}

/** A table's rows, the header row's cells grey and bold on a tint, as the mock-up draws them, each row ruled below. */
function tableRowsOf(table: Node): PptxGenJS.TableRow[] {
	return table.children.map((row) =>
		row.children.map((cell) => {
			const header = cell.type.name === "tableHeader";
			const padding = header ? HEADER_CELL_PADDING : CELL_PADDING;
			return {
				text: textOf(paragraphsIn(cell.children, header ? TABLE_HEADER_TEXT : TABLE_TEXT)),
				options: {
					margin: [padding.y, padding.x, padding.y, padding.x].map(
						(points) => points / POINTS_PER_INCH,
					) as [number, number, number, number],
					border: [NO_BORDER, NO_BORDER, { type: "solid", pt: 1, color: RULE }, NO_BORDER],
					...(header ? { fill: { color: TINT } } : {}),
				},
			};
		}),
	);
}

const NO_BORDER: PptxGenJS.BorderProps = { type: "none" };

/** The look of a box's or a placeholder's text, which each paragraph and run in it takes unless it says otherwise. */
const textOptions = (style: TextStyle) => ({
	fontSize: style.size,
	color: style.color,
	...(style.bold ? { bold: true } : {}),
	...(style.italic ? { italic: true } : {}),
	lineSpacingMultiple: style.lineHeight / ARIAL_LINE_HEIGHT,
	...(style.gap > 0 ? { paraSpaceAfter: style.gap } : {}),
});

type Run = PptxGenJS.TextProps;
type RunOptions = PptxGenJS.TextPropsOptions;

/** A paragraph of PowerPoint's: its runs, and its bullet or number and depth in a list. */
interface Paragraph {
	runs: readonly Run[];
	bullet?: RunOptions["bullet"];
	level?: number;
}

const paragraphsIn = (blocks: readonly Node[], style: TextStyle): Paragraph[] =>
	blocks.flatMap((block) => paragraphsOf(block, style));

/**
 * A block as PowerPoint's paragraphs. A list's items are its bullets or
 * numbers, an item's own blocks the lines of its paragraph and a list in it
 * the level below; a quote is its blocks in grey italics; a code block is its
 * lines in a monospace font; and a table within something else, which
 * PowerPoint can't hold in text, is a line for each row, its cells apart by
 * a tab. Anything else is its text.
 */
function paragraphsOf(block: Node, style: TextStyle): Paragraph[] {
	const base = textOptions(style);
	switch (block.type.name) {
		case "heading": {
			const scale = style.headingScale[Number(block.attrs.level)] ?? 1;
			return [{ runs: runsOf(block, { ...base, fontSize: style.size * scale, bold: true }) }];
		}
		case "bulletList":
		case "orderedList":
			return listParagraphs(block, style, 0);
		case "blockquote":
			return paragraphsIn(block.children, { ...style, ...QUOTED });
		case "codeBlock":
			return [{ runs: codeRuns(block, base) }];
		case "table":
			return block.children.map((row) => ({ runs: rowRuns(row, style) }));
		default:
			return [
				{
					runs: block.isTextblock
						? runsOf(block, base)
						: [{ text: block.textContent, options: { ...base } }],
				},
			];
	}
}

const isList = (block: Node) => ["bulletList", "orderedList"].includes(block.type.name);

function listParagraphs(list: Node, style: TextStyle, level: number): Paragraph[] {
	return list.children.flatMap((item) => {
		const lines = item.children
			.filter((child) => !isList(child))
			.flatMap((child) => paragraphsOf(child, style).map(({ runs }) => runs));
		const nested = item.children
			.filter(isList)
			.flatMap((child) => listParagraphs(child, style, level + 1));
		return [
			{ runs: joinedLines(lines, textOptions(style)), bullet: bulletOf(list, style, level), level },
			...nested,
		];
	});
}

function bulletOf(list: Node, style: TextStyle, level: number): RunOptions["bullet"] {
	const indent = style.size * BULLET_INDENT_EM;
	if (list.type.name === "orderedList") {
		return { type: "number", indent, numberStartAt: Number(list.attrs.start) || 1 };
	}
	return { indent, characterCode: BULLET_CHARACTERS[level % BULLET_CHARACTERS.length] };
}

/** Lines as one paragraph's runs, a line break between each two. */
function joinedLines(lines: readonly (readonly Run[])[], base: RunOptions): Run[] {
	return lines.flatMap((runs, index) => {
		const [first = { text: "", options: { ...base } }, ...rest] = runs;
		if (index === 0) return [first, ...rest];
		return [{ ...first, options: { ...first.options, softBreakBefore: true } }, ...rest];
	});
}

function codeRuns(block: Node, base: RunOptions): Run[] {
	return block.textContent.split("\n").map((line, index) => ({
		text: line,
		options: {
			...base,
			fontFace: CODE_FONT,
			fontSize: (base.fontSize ?? 0) * CODE_SCALE,
			...(index > 0 ? { softBreakBefore: true } : {}),
		},
	}));
}

function rowRuns(row: Node, style: TextStyle): Run[] {
	const base = textOptions(style);
	return row.children.flatMap((cell, index) => [
		...(index > 0 ? [{ text: "\t", options: { ...base } }] : []),
		...joinedLines(
			paragraphsIn(cell.children, style).map(({ runs }) => runs),
			base,
		),
	]);
}

/** A textblock's line as runs of `base`, each with its marks. An image in it is its words. */
function runsOf(textblock: Node, base: RunOptions): Run[] {
	return textblock.children.map((inline) => {
		const options = { ...base, ...markOptions(inline.marks) };
		if (inline.type.name === "hardBreak")
			return { text: "", options: { ...base, softBreakBefore: true } };
		if (inline.type.name === "image") {
			return {
				text: String(inline.attrs.alt ?? ""),
				options: { ...options, ...linkTo(inline.attrs.link) },
			};
		}
		return { text: inline.textContent, options };
	});
}

const markOptions = (marks: readonly Mark[]): RunOptions =>
	Object.assign({}, ...marks.map((mark) => MARK_OPTIONS[mark.type.name]?.(mark) ?? {}));

const MARK_OPTIONS: Readonly<Record<string, (mark: Mark) => RunOptions>> = {
	bold: () => ({ bold: true }),
	italic: () => ({ italic: true }),
	strike: () => ({ strike: "sngStrike" }),
	underline: () => ({ underline: { style: "sng" } }),
	code: () => ({ fontFace: CODE_FONT }),
	superscript: () => ({ superscript: true }),
	subscript: () => ({ subscript: true }),
	highlight: () => ({ highlight: HIGHLIGHT_YELLOW }),
	link: (mark) => linkTo(mark.attrs.href),
};

/**
 * A link to `href`, when it goes somewhere a link in the editor may. A link
 * keeps its text's colour and is underlined, as the app draws one.
 */
const linkTo = (href: unknown): { hyperlink?: PptxGenJS.HyperlinkProps } =>
	typeof href === "string" && linkMayGoTo(href) ? { hyperlink: { url: href } } : {};

/**
 * Paragraphs as PptxGenJS's runs: each paragraph's bullet and depth on its
 * first run, which PowerPoint takes the paragraph's from, and a break after
 * its last. An empty paragraph is an empty run, a blank line.
 */
function textOf(paragraphs: readonly Paragraph[]): Run[] {
	return paragraphs.flatMap(({ runs, bullet, level }) => {
		const [first = { text: "" }, ...rest] = runs;
		const all = [
			{ ...first, options: { ...first.options, bullet, ...(level ? { indentLevel: level } : {}) } },
			...rest,
		];
		return all.map((run, index) =>
			index === all.length - 1 ? { ...run, options: { ...run.options, breakLine: true } } : run,
		);
	});
}

/**
 * `file`, as PptxGenJS writes it, with what it writes otherwise than
 * PowerPoint does made as PowerPoint writes it: each slide's paragraphs with
 * their properties once, each shape with an id of its own, an image without
 * words given none, and no empty placeholder under what a region's stacked
 * parts show; each slide's notes as
 * their paragraphs, which it writes as one run; each layout's placeholders
 * with their text's edge, no padding and text that shrinks to fit, so a slide
 * made from one in PowerPoint is laid out as the deck's are; no layout but
 * the deck's; and no entries for folders.
 */
async function withPowerPointsOwnForms(
	file: Awaited<ReturnType<PptxGenJS["write"]>>,
	slides: readonly DrawnSlide[],
): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(file);
	await Promise.all([
		...slides.map((slide, index) =>
			rewritten(zip, `ppt/slides/slide${index + 1}.xml`, (xml) =>
				withShapeIdsOfTheirOwn(
					withoutPlaceholders(
						withParagraphPropertiesOnce(xml.replaceAll(MADE_UP_IMAGE_WORDS, "")),
						slide.stacked,
					),
				),
			),
		),
		...slides.map((slide, index) =>
			rewritten(zip, `ppt/notesSlides/notesSlide${index + 1}.xml`, (xml) =>
				withNotes(xml, slide.notes),
			),
		),
		...SLIDE_LAYOUTS.map((layout, index) =>
			rewritten(zip, `ppt/slideLayouts/slideLayout${index + FIRST_DECK_LAYOUT}.xml`, (xml) =>
				withRegionsLaidOut(xml, LAYOUTS[layout].regions),
			),
		),
	]);
	await withoutDefaultLayout(zip);
	return (await filesOf(zip)).generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** `zip`'s files in order, without the entries PptxGenJS writes for its folders, which some cloud services fail to open a file holding. */
async function filesOf(zip: JSZip): Promise<JSZip> {
	const entries = Object.values(zip.files).filter((entry) => !entry.dir);
	const contents = await Promise.all(entries.map((entry) => entry.async("uint8array")));
	const files = new JSZip();
	entries.forEach((entry, index) => {
		files.file(entry.name, contents[index] ?? new Uint8Array(), { createFolders: false });
	});
	return files;
}

/** PptxGenJS writes a blank layout of its own first, which no slide here uses, then the deck's. */
const DEFAULT_LAYOUT = "slideLayout1.xml";
const FIRST_DECK_LAYOUT = 2;

async function rewritten(zip: JSZip, path: string, change: (xml: string) => string) {
	const part = zip.file(path);
	if (!part) throw new Error(`PptxGenJS wrote no ${path}`);
	zip.file(path, change(await part.async("string")));
}

/** The words PptxGenJS gives an image that has none, the name it files an image's bytes under. */
const MADE_UP_IMAGE_WORDS = ' descr="preencoded.png"';

/** A paragraph's properties, which PptxGenJS writes before each of its runs, and PowerPoint reads once, first. */
const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g;

const withParagraphPropertiesOnce = (xml: string) =>
	xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
		let first = true;
		return paragraph.replace(PARAGRAPH_PROPERTIES, (properties) => {
			const kept = first ? properties : "";
			first = false;
			return kept;
		});
	});

/** `xml` with each of its shapes changed by `change`. A slide or layout of PptxGenJS's holds no shape in another. */
const eachShape = (xml: string, change: (shape: string) => string) =>
	xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, change);

const placeholderIndexOf = (shape: string) =>
	Number(/<p:ph\b[^>]*\bidx="(\d+)"/.exec(shape)?.[1] ?? Number.NaN);

/** `xml` without the placeholders numbered `indexes`, which PptxGenJS adds to a slide empty where it was given nothing for them. */
const withoutPlaceholders = (xml: string, indexes: readonly number[]) =>
	eachShape(xml, (shape) => (indexes.includes(placeholderIndexOf(shape)) ? "" : shape));

/** `xml` with its shapes numbered in order: PptxGenJS numbers a table as it may number another shape. */
function withShapeIdsOfTheirOwn(xml: string): string {
	let id = 0;
	return xml.replace(/(<p:cNvPr id=")\d+"/g, (_id, start: string) => {
		id += 1;
		return `${start}${id}"`;
	});
}

/** The body of a notes slide, which PptxGenJS writes holding the notes as one run. */
const NOTES_BODY = /(<p:ph type="body" idx="1"\/>[\s\S]*?)<p:txBody>[\s\S]*?<\/p:txBody>/;

const withNotes = (xml: string, notes: readonly Node[]) =>
	xml.replace(
		NOTES_BODY,
		(_body, before: string) =>
			`${before}<p:txBody><a:bodyPr/><a:lstStyle/>${notes.map(noteParagraph).join("")}</p:txBody>`,
	);

/** A paragraph of notes, with its bold, italics, underline, strikethrough, superscript and subscript; anything else in it is its text. */
function noteParagraph(paragraph: Node): string {
	const runs = paragraph.children.map((inline) => {
		if (inline.type.name === "hardBreak") return "<a:br/>";
		const text = inline.type.name === "image" ? String(inline.attrs.alt ?? "") : inline.textContent;
		if (!text) return "";
		const attributes = inline.marks
			.map((mark) => NOTE_MARK_ATTRIBUTES[mark.type.name] ?? "")
			.join("");
		return `<a:r><a:rPr lang="en-US"${attributes} dirty="0"/><a:t>${escapeXml(text)}</a:t></a:r>`;
	});
	return `<a:p>${runs.join("")}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
}

const NOTE_MARK_ATTRIBUTES: Readonly<Record<string, string>> = {
	bold: ' b="1"',
	italic: ' i="1"',
	underline: ' u="sng"',
	strike: ' strike="sngStrike"',
	superscript: ' baseline="30000"',
	subscript: ' baseline="-25000"',
};

/** What PptxGenJS writes for a layout placeholder's text box, saying nothing of its edge or padding. */
const LAYOUT_BODY_PROPERTIES = '<a:bodyPr wrap="square" rtlCol="0"></a:bodyPr>';

const withRegionsLaidOut = (xml: string, regions: readonly Region[]) =>
	eachShape(xml, (shape) => {
		const region = regions[placeholderIndexOf(shape) - FIRST_PLACEHOLDER_INDEX];
		if (!region) return shape;
		const anchor = region.anchor === "top" ? "t" : "b";
		return shape.replace(
			LAYOUT_BODY_PROPERTIES,
			`<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr>`,
		);
	});

/** `zip` without PptxGenJS's blank layout, so PowerPoint's Layout menu lists the deck's alone. */
async function withoutDefaultLayout(zip: JSZip) {
	const masterRelationships = "ppt/slideMasters/_rels/slideMaster1.xml.rels";
	const relationships = await zip.file(masterRelationships)?.async("string");
	const relationship = new RegExp(
		`<Relationship Id="(rId\\d+)"[^>]*Target="\\.\\./slideLayouts/${DEFAULT_LAYOUT}"/>`,
	).exec(relationships ?? "");
	if (!relationships || !relationship) return;
	const [written, id] = relationship;
	await Promise.all([
		rewritten(zip, masterRelationships, (xml) => xml.replace(written, "")),
		rewritten(zip, "ppt/slideMasters/slideMaster1.xml", (xml) =>
			xml.replace(new RegExp(`<p:sldLayoutId id="\\d+" r:id="${id}"/>`), ""),
		),
		rewritten(zip, "[Content_Types].xml", (xml) =>
			xml.replace(
				new RegExp(`<Override PartName="/ppt/slideLayouts/${DEFAULT_LAYOUT}"[^>]*/>`),
				"",
			),
		),
	]);
	zip.remove(`ppt/slideLayouts/${DEFAULT_LAYOUT}`);
	zip.remove(`ppt/slideLayouts/_rels/${DEFAULT_LAYOUT}.rels`);
}

const escapeXml = (text: string) =>
	text.replace(/[&<>"]/g, (character) => XML_ENTITIES[character] ?? character);

const XML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};
