import {
	type Artifact,
	type ArtifactImageType,
	MAX_ARTIFACT_IMAGES_BYTES,
} from "@sugabots/contracts";
import type { ArtifactImageIds } from "@sugabots/contracts/http";
import { placementOf, SPEAKER_NOTES } from "@sugabots/contracts/live-slides";
import {
	type BoxRole,
	type BoxRoleOf,
	type Frame,
	type Placement,
	SLIDE_BOX_ROLES,
	SLIDE_END_MARGIN,
	SLIDE_LAYOUTS,
	SLIDE_SIDE_MARGINS,
	SLIDE_UNIT,
	type SlideLayout,
} from "@sugabots/contracts/slides-markdown";
import { Fragment, type Mark, type Node } from "@tiptap/pm/model";
import { Effect } from "effect";
import { imageSize } from "image-size";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import PptxGenJS from "pptxgenjs";
import { typesetterOn } from "./pdf-fonts.ts";
import {
	ACCENT,
	accentBarOver,
	BACKGROUND,
	BLOCK_QUOTE_LOOK,
	type BlocksOfLayout,
	BOLD_WEIGHT,
	BOX_PARTS,
	CODE_LOOK,
	COLUMN_GAP_UNITS,
	COLUMN_LOOK,
	CONTENT_BOTTOM,
	CONTENT_HEIGHT,
	childNamed,
	contentWidthOf,
	type DeckImage,
	IMAGE_LAYOUT,
	isEmptyParagraph,
	LAYOUT_LOOKS,
	LIST_LOOK,
	linkInFile,
	ownImagesIn,
	type PartLook,
	partLook,
	QUOTE_LOOK,
	RULE,
	RULE_THICKNESS,
	SECTION_BAR,
	type SlidePart,
	slideBlocksOf,
	TABLE_LOOK,
	TEXT,
	type TextLook,
	TINT,
} from "./slide-design.ts";
import {
	arrangedSlide,
	heightOfBlocks,
	type Measure,
	type Placing,
	rowHeightsOf,
	type Size,
} from "./slide-layout.ts";

/** The media type of a .pptx file. */
export const POWERPOINT_CONTENT_TYPE =
	"application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** An image for the PowerPoint file to hold: its bytes, and their media type. */
export type PowerPointImage = DeckImage;

/**
 * `deck`, a `slides` deck as people see it, as a PowerPoint file titled as
 * the artifact is, 16:9, a slide for each of the deck's in order, without the
 * boxes people removed from them. Each of the deck's layouts
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
 * Each slide's text is set at the step the app draws it at, the largest of
 * its steps at which it fits, as the PDF finds it (`slide-layout.ts`), and
 * each of its boxes is placed where the app sets its text at that step, as
 * tall as that text with room to spare for Arial, so a slide shows fitted
 * wherever the file is opened. Text is also set to shrink on overflow, which
 * a presentation program works out when the text is next edited, for a slide
 * that runs over even at the smallest step.
 *
 * A slide whose boxes somebody placed by hand has each region at the frame of
 * the box it stands for (`Region.box`), from the frame's top, as the app
 * draws a placed slide, and its text at the step the app fits it at.
 *
 * Whatever a layout has no place for, such as a table on a title slide, is
 * stacked with the rest of what its region holds, in boxes of its own, so
 * nothing the deck holds is left out.
 */
export const powerPointFileOf = <E, R>(
	artifact: Pick<Artifact, "podId" | "id" | "title">,
	deck: Node,
	imageOf: (image: ArtifactImageIds) => Effect.Effect<PowerPointImage | undefined, E, R>,
): Effect.Effect<Uint8Array, E, R> =>
	Effect.gen(function* () {
		const own = ownImagesIn(deck, { podId: artifact.podId, artifactId: artifact.id });
		const found = yield* Effect.forEach(own, ([address, ids]) =>
			Effect.map(imageOf(ids), (image) => [address, image && drawable(image)] as const),
		);
		const drawn = new Map(
			found.flatMap(([address, image]) => (image ? [[address, image] as const] : [])),
		);
		const { presentation, slides } = presentationOf(
			artifact.title,
			deck,
			imageDrawer(drawn),
			measureOf(drawn),
		);
		return yield* Effect.promise(async () =>
			withPowerPointsOwnForms(await presentation.write({ outputType: "uint8array" }), slides),
		);
	});

/*
 * Positions and sizes are in points, a slide's pixels (`slide-design.ts`), as
 * many across as PowerPoint's 13.33in-wide 16:9 slide has.
 */

const POINTS_PER_INCH = 72;

/** The units a file's positions are in. */
const EMUS_PER_POINT = 12_700;

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

/**
 * How much taller than the app's measure of its text a box is made, as a
 * share of that height, for the text set in Arial rather than the app's
 * Rubik. Arial runs 1 to 7% narrower than Rubik on a slide's words, and wraps
 * them in no more lines, but a line of wide capitals can run 5% wider, and a
 * program that takes Arial's single line spacing as 1.2 times its size,
 * rather than the 1.15 it is, sets lines 4% further apart.
 */
const ARIAL_ALLOWANCE = 0.05;

/** The bullets of each level of a list, as a browser draws them. */
const BULLET_CHARACTERS = ["2022", "25E6", "25AA"];

/** A box on a slide, as PptxGenJS places one: its left, top, width and height. */
interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A part of a layout of `L`, which is a placeholder of the file's, standing for one of the layout's boxes. */
interface Region<L extends SlideLayout> {
	/** Its placeholder's name, by which a slide's text for it is put in it. */
	name: string;
	/** What PowerPoint takes it for: the slide's title, or its text. */
	type: "title" | "body";
	/** What it shows when empty on a slide made in PowerPoint. */
	prompt: string;
	/** How text typed into it on a slide made in PowerPoint looks. */
	writes: TextLook;
	/** How tall the text its box has room for is on a slide made in PowerPoint, in points. */
	room: number;
	/** The edge of its box its text sits against. */
	anchor: "top" | "bottom";
	/**
	 * The box of a slide it stands for: it holds what the box holds, set as
	 * the app sets that box's part of the slide (`BOX_PARTS`), and once
	 * somebody placed the slide's boxes by hand, it is at the box's frame. A
	 * section break's text stands for its label, which has a frame of its
	 * own, and its title for the whole of its title's box.
	 */
	box: BoxRoleOf<L>;
	/**
	 * What a slide its layout places holds in it, when that isn't what its box
	 * holds: on a section break, whose label the file's layout has no place
	 * over its title for.
	 */
	holds?(blocks: BlocksOfLayout<L>): readonly Node[];
}

/** A region standing for the box of role `R`, for any layout with a box of that role. */
type RegionFor<R extends BoxRole> = Omit<Region<SlideLayout>, "box" | "holds"> & { box: R };

/** How tall the text a slide puts in its region numbered `region` is, set across `width`, in points: 0 for none. */
type HeightOf = (region: number, width: number) => number;

/** Where a slide's regions' boxes are, in the order of its layout's regions, and the section break's accent bar. */
interface Placed {
	boxes: readonly Box[];
	bar?: Box;
}

/** A slide's text, which a layout places its regions for. */
interface TextToPlace {
	/** The step it is set at, one of `SLIDE_TEXT_STEPS`. */
	step: number;
	/** How tall it is in each region. */
	heightOf: HeightOf;
	/** Whether the slide fits at `step`. */
	fits: boolean;
	/** Whether the slide shows a section break's label, which its accent bar goes with. */
	labelled: boolean;
}

/** Where a layout's regions are for `text`, as the app places it. */
type Place = (text: TextToPlace) => Placed;

/** One of the deck's layouts, `L`, as a layout of the file's. */
interface LayoutDesign<L extends SlideLayout> {
	/** Its name in PowerPoint's Layout menu, as the app's layout picker names it. */
	name: string;
	regions: readonly Region<L>[];
	place: Place;
}

/** The height of `count` lines of `look` at full size. */
const lines = (count: number, look: TextLook) => count * look.size * SLIDE_UNIT * look.lineHeight;

/** Text `height` tall, with Arial's allowance. */
const grown = (height: number) => height * (1 + ARIAL_ALLOWANCE);

/** A box for text `height` tall, from `top` down. */
const below = (x: number, w: number, top: number, height: number): Box => ({
	x,
	y: top,
	w,
	h: grown(height),
});

/** A box for text `height` tall, up from `bottom`. */
const above = (x: number, w: number, bottom: number, height: number): Box => ({
	x,
	y: bottom - grown(height),
	w,
	h: grown(height),
});

/**
 * A box from `top` to the margin at the slide's foot, as the app lets the
 * text under a slide's title run, or further for text `height` tall that fits
 * at its step. Text that runs over even at the smallest step keeps to the
 * margin, so shrinking it when it is edited fits it within.
 */
const toFoot = (x: number, w: number, top: number, height: number, fits: boolean): Box => ({
	x,
	y: top,
	w,
	h: fits ? Math.max(CONTENT_BOTTOM - top, grown(height)) : CONTENT_BOTTOM - top,
});

/**
 * A section break's title and text, as its regions hold them. The file's
 * layout has no place over a title for a label, so a section break with a
 * label is all text, in the order it reads; without one, a heading its title
 * box starts with is its title, and what follows it is text.
 */
function sectionParts(blocks: BlocksOfLayout<"section">): {
	title: readonly Node[];
	text: readonly Node[];
} {
	if (!blocks.inBox("label").every(isEmptyParagraph)) return { title: [], text: blocks.all };
	const [first, ...rest] = blocks.inBox("title");
	if (first?.type.name !== "heading") return { title: [], text: blocks.inBox("title") };
	return { title: [first], text: rest };
}

/** The region standing for a slide's title box, which PowerPoint takes for its title. */
const titleRegion = (
	writes: TextLook,
	room: number,
	anchor: Region<SlideLayout>["anchor"],
): RegionFor<"title"> => ({
	name: "title",
	type: "title",
	prompt: "Title",
	writes,
	room,
	anchor,
	box: "title",
});

const TOP_TITLE = titleRegion(
	LAYOUT_LOOKS.bullets.heading,
	lines(1, LAYOUT_LOOKS.bullets.heading),
	"top",
);

/** A body region running from under the title to the margin at the slide's foot, standing for the box of `box`. */
const footRegion = <R extends BoxRole>(
	name: string,
	prompt: string,
	writes: TextLook,
	box: R,
): RegionFor<R> => ({
	name,
	type: "body",
	prompt,
	writes,
	room: 0,
	anchor: "top",
	box,
});

/** The title across the top, and `columns` regions side by side under it, as far under it as `layout` sets its blocks apart. */
const underTitle =
	(layout: SlideLayout, columns: 1 | 2): Place =>
	({ step, heightOf, fits }) => {
		const unit = step * SLIDE_UNIT;
		const sideMargin = SLIDE_SIDE_MARGINS[layout];
		const contentWidth = contentWidthOf(layout);
		const title = heightOf(0, contentWidth);
		const top = SLIDE_END_MARGIN + (title > 0 ? title + LAYOUT_LOOKS[layout].gap * unit : 0);
		const gap = COLUMN_GAP_UNITS * unit;
		const width = columns === 1 ? contentWidth : (contentWidth - gap) / 2;
		return {
			boxes: [
				below(sideMargin, contentWidth, SLIDE_END_MARGIN, title),
				...Array.from({ length: columns }, (_, index) =>
					toFoot(sideMargin + index * (width + gap), width, top, heightOf(index + 1, width), fits),
				),
			],
		};
	};

/** Two regions one over the other, together in the middle of `layout`'s margins, as far apart as it sets its blocks. */
const centred =
	(layout: SlideLayout): Place =>
	({ step, heightOf }) => {
		const x = SLIDE_SIDE_MARGINS[layout];
		const width = contentWidthOf(layout);
		const first = heightOf(0, width);
		const second = heightOf(1, width);
		const gap = first > 0 && second > 0 ? LAYOUT_LOOKS[layout].gap * step * SLIDE_UNIT : 0;
		const top = SLIDE_END_MARGIN + Math.max(0, (CONTENT_HEIGHT - first - gap - second) / 2);
		return {
			boxes: [above(x, width, top + first, first), below(x, width, top + first + gap, second)],
		};
	};

/**
 * The section break's accent bar, while it has a label, its title and its
 * text, one under another at the margin at the slide's foot.
 */
const atFoot: Place = ({ step, heightOf, labelled }) => {
	const unit = step * SLIDE_UNIT;
	const sideMargin = SLIDE_SIDE_MARGINS.section;
	const width = contentWidthOf("section");
	const gap = LAYOUT_LOOKS.section.gap * unit;
	const bar = { w: SECTION_BAR.width * unit, h: SECTION_BAR.height * unit };
	const title = heightOf(0, width);
	const text = heightOf(1, width);
	const shown = [labelled ? bar.h : 0, title, text].filter((height) => height > 0);
	const height = shown.reduce((sum, each) => sum + each, 0) + gap * Math.max(0, shown.length - 1);
	const top = SLIDE_END_MARGIN + Math.max(0, CONTENT_HEIGHT - height);
	const titleTop = top + (labelled ? bar.h + gap : 0);
	const textTop = titleTop + (title > 0 ? title + gap : 0);
	return {
		boxes: [
			above(sideMargin, width, titleTop + title, title),
			below(sideMargin, width, textTop, text),
		],
		bar: labelled ? { x: sideMargin, y: top, ...bar } : undefined,
	};
};

/** The title and the text box under it together in the middle of the left, and the image box in the middle of the right. */
const besideImage: Place = ({ step, heightOf }) => {
	const unit = step * SLIDE_UNIT;
	const sideMargin = SLIDE_SIDE_MARGINS.image;
	const gap = COLUMN_GAP_UNITS * unit;
	const width = (contentWidthOf("image") - gap) / 2;
	const title = heightOf(0, width);
	const text = heightOf(1, width);
	const image = heightOf(2, width);
	const titleGap = title > 0 ? IMAGE_LAYOUT.titleGap * unit : 0;
	const left = title + titleGap + text;
	const height = Math.max(CONTENT_HEIGHT, left, image);
	const leftTop = SLIDE_END_MARGIN + (height - left) / 2;
	return {
		boxes: [
			above(sideMargin, width, leftTop + title, title),
			below(sideMargin, width, leftTop + title + titleGap, text),
			below(sideMargin + width + gap, width, SLIDE_END_MARGIN + (height - image) / 2, image),
		],
	};
};

/**
 * Where `regions`, a layout's, are on a slide of that `layout` whose boxes
 * somebody placed by hand, at `step`: each at the frame of the box it stands
 * for (`Region.box`), across it, its text from the frame's top, as the app
 * draws a placed box, but in the middle of the frame for the image layout's
 * image box, which the app centres there. A region whose text sits at the
 * foot of its box is as tall as its text; another reaches the frame's foot at
 * least. The section break's accent bar is over its label, while it shows one.
 */
function placedRegions(
	regions: readonly Region<SlideLayout>[],
	layout: SlideLayout,
	placement: Placement,
	step: number,
	heightOf: HeightOf,
	labelled: boolean,
): Placed {
	const boxes = regions.map((region, index): Box => {
		const frame = frameOfBox(placement, layout, region.box);
		const height = heightOf(index, frame.width);
		const top = region.box === "image" ? frame.y + (frame.height - height) / 2 : frame.y;
		if (region.anchor === "bottom") return above(frame.x, frame.width, top + height, height);
		return {
			x: frame.x,
			y: top,
			w: frame.width,
			h: Math.max(frame.y + frame.height - top, grown(height)),
		};
	});
	if (!labelled) return { boxes };
	const bar = accentBarOver(frameOfBox(placement, layout, "label"), step * SLIDE_UNIT);
	return { boxes, bar: { x: bar.x, y: bar.y, w: bar.width, h: bar.height } };
}

/** The frame of the box of `role` on a slide of `layout` placed at `placement`. */
function frameOfBox(placement: Placement, layout: SlideLayout, role: BoxRole): Frame {
	const roles: readonly BoxRole[] = SLIDE_BOX_ROLES[layout];
	const frame = placement[roles.indexOf(role)];
	if (!frame) throw new Error(`A slide laid out as ${layout} has no box for its ${role}`);
	return frame;
}

/** Each of the deck's layouts as the file lays it out, after the mock-ups the app draws. */
const LAYOUTS: { readonly [L in SlideLayout]: LayoutDesign<L> } = {
	title: {
		name: "Title",
		regions: [
			titleRegion(LAYOUT_LOOKS.title.heading, lines(2, LAYOUT_LOOKS.title.heading), "bottom"),
			{
				name: "subtitle",
				type: "body",
				prompt: "Subtitle",
				writes: LAYOUT_LOOKS.title.text,
				room: lines(2, LAYOUT_LOOKS.title.text),
				anchor: "top",
				box: "subtitle",
			},
		],
		place: centred("title"),
	},
	bullets: {
		name: "Title and bullets",
		regions: [TOP_TITLE, footRegion("body", "Text", LAYOUT_LOOKS.bullets.text, "body")],
		place: underTitle("bullets", 1),
	},
	columns: {
		name: "Two columns",
		regions: [
			TOP_TITLE,
			footRegion("left", "Left column", COLUMN_LOOK.text, "leftColumn"),
			footRegion("right", "Right column", COLUMN_LOOK.text, "rightColumn"),
		],
		place: underTitle("columns", 2),
	},
	image: {
		name: "Image and text",
		regions: [
			titleRegion(LAYOUT_LOOKS.image.heading, lines(2, LAYOUT_LOOKS.image.heading), "bottom"),
			{
				name: "text",
				type: "body",
				prompt: "Text",
				writes: IMAGE_LAYOUT.text,
				room: lines(3, IMAGE_LAYOUT.text),
				anchor: "top",
				box: "text",
			},
			{
				name: "image",
				type: "body",
				prompt: "Image",
				writes: IMAGE_LAYOUT.text,
				room: CONTENT_HEIGHT,
				anchor: "top",
				box: "image",
			},
		],
		place: besideImage,
	},
	section: {
		name: "Section break",
		regions: [
			{
				...titleRegion(
					LAYOUT_LOOKS.section.heading,
					lines(2, LAYOUT_LOOKS.section.heading),
					"bottom",
				),
				holds: (blocks) => sectionParts(blocks).title,
			},
			{
				name: "body",
				type: "body",
				prompt: "Text",
				writes: LAYOUT_LOOKS.section.text,
				room: lines(1, LAYOUT_LOOKS.section.text),
				anchor: "top",
				box: "label",
				holds: (blocks) => sectionParts(blocks).text,
			},
		],
		place: atFoot,
	},
	quote: {
		name: "Quote",
		regions: [
			{
				name: "quote",
				// The slide's title, as PowerPoint's own quote layouts have it, for an outline and a screen reader.
				type: "title",
				prompt: "Quote",
				writes: QUOTE_LOOK,
				room: lines(3, QUOTE_LOOK),
				anchor: "bottom",
				box: "quote",
			},
			{
				name: "attribution",
				type: "body",
				prompt: "Who said it",
				writes: LAYOUT_LOOKS.quote.text,
				room: lines(1, LAYOUT_LOOKS.quote.text),
				anchor: "top",
				box: "attribution",
			},
		],
		place: centred("quote"),
	},
	table: {
		name: "Table",
		regions: [TOP_TITLE, footRegion("table", "Table", LAYOUT_LOOKS.table.text, "table")],
		place: underTitle("table", 1),
	},
};

/**
 * What `blocks`, a slide's, puts in each region of the slide's layout: what
 * the region's box holds, or, on a slide its layout places, rather than one
 * `placed` by hand, what the region holds of it (`Region.holds`). Nothing for
 * a region that would hold only empty lines.
 */
function heldInRegions<L extends SlideLayout>(
	blocks: BlocksOfLayout<L>,
	placed: boolean,
): (readonly Node[])[] {
	const regions: readonly Region<L>[] = LAYOUTS[blocks.layout].regions;
	return regions.map((region) => {
		const holds = placed || !region.holds ? blocks.inBox(region.box) : region.holds(blocks);
		return holds.every(isEmptyParagraph) ? [] : holds;
	});
}

/** Where a layout's regions are on a slide made from it in PowerPoint: with room for the text each is made for, a section break's label included. */
const roomyBoxes = ({ regions, place }: LayoutDesign<SlideLayout>) =>
	place({
		step: 1,
		heightOf: (region) => regions[region]?.room ?? 0,
		fits: true,
		labelled: true,
	}).boxes;

/**
 * PptxGenJS numbers a layout's placeholders from 100, in the order they are
 * defined, which the regions are.
 */
const FIRST_PLACEHOLDER_INDEX = 100;

/** An image the file can hold: as PptxGenJS takes it, with its size in pixels. */
interface DrawableImage {
	data: string;
	width: number;
	height: number;
	/** Its size as it is shown, upright, which its EXIF orientation may turn on its side. */
	upright: Size;
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
	const { width, height, sideways } = size;
	return {
		data: `${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
		width,
		height,
		upright: sideways ? { width: height, height: width } : { width, height },
		byteLength: bytes.byteLength,
	};
}

function sizeOf(
	bytes: Uint8Array,
): { width: number; height: number; sideways: boolean } | undefined {
	try {
		const { width, height, orientation } = imageSize(bytes);
		return width && height ? { width, height, sideways: (orientation ?? 1) > 4 } : undefined;
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

/**
 * What the deck's slides are measured with, as the app lays them out: their
 * text in the app's fonts, measured as the PDF measures it, on a PDFKit
 * document that is only measured with and never written, and the images the
 * file holds.
 */
function measureOf(images: ReadonlyMap<string, DrawableImage>): Measure {
	const typesetter = typesetterOn(new PDFDocument({ autoFirstPage: false }));
	return {
		widthOf: typesetter.widthOf,
		imageSizeAt: (address) => images.get(address)?.upright,
	};
}

/** What the file's own forms need to know of each slide once PptxGenJS has written it. */
interface DrawnSlide {
	/** Its speaker notes' paragraphs. */
	notes: readonly Node[];
	/** The placeholders it shows nothing in: those its regions leave empty, and those whose region's parts are stacked in boxes of their own. */
	unused: readonly number[];
	/** Where each placeholder it puts text in is on it, by number. */
	boxes: ReadonlyMap<number, Box>;
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
	measure: Measure,
): { presentation: PptxGenJS; slides: DrawnSlide[] } {
	const presentation = new PptxGenJS();
	presentation.layout = "LAYOUT_WIDE";
	presentation.title = title;
	presentation.author = "";
	presentation.company = "";
	presentation.subject = "";
	presentation.theme = { headFontFace: FONT, bodyFontFace: FONT };
	for (const layout of SLIDE_LAYOUTS) presentation.defineSlideMaster(masterOf(layout));
	const slides = deck.children.map((slide) => addSlide(presentation, slide, draw, measure));
	return { presentation, slides };
}

function masterOf(layout: SlideLayout): PptxGenJS.SlideMasterProps {
	const design: LayoutDesign<SlideLayout> = LAYOUTS[layout];
	const boxes = roomyBoxes(design);
	return {
		title: design.name,
		background: { color: BACKGROUND },
		objects: design.regions.map((region, index) => ({
			placeholder: {
				options: placeholderOptions(layout, region, boxes[index]),
				text: region.prompt,
			},
		})),
	};
}

/**
 * A region as a placeholder: its box, and the look of text typed into it on a
 * slide made from the layout, which states no space after a paragraph, as a
 * slide's own paragraphs state theirs.
 */
function placeholderOptions(
	layout: SlideLayout,
	region: Region<SlideLayout>,
	box: Box | undefined,
): PptxGenJS.PlaceholderProps {
	const style = styleOf(region.writes, SLIDE_UNIT);
	const options: PptxGenJS.PlaceholderProps &
		Pick<PptxGenJS.TextPropsOptions, "lineSpacingMultiple"> = {
		name: region.name,
		type: region.type,
		...(box ? inchesOf(box) : {}),
		fontSize: style.size,
		color: style.color,
		...(style.bold ? { bold: true } : {}),
		lineSpacingMultiple: style.lineHeight / ARIAL_LINE_HEIGHT,
		align: alignOf(partLook(layout, BOX_PARTS[region.box])),
		valign: region.anchor,
		margin: 0,
	};
	return options;
}

const alignOf = (look: PartLook) => (look.align === "center" ? "center" : "left");

function addSlide(
	presentation: PptxGenJS,
	slide: Node,
	draw: ImageDrawer,
	measure: Measure,
): DrawnSlide {
	const blocks = slideBlocksOf(slide);
	const { layout } = blocks;
	const design: LayoutDesign<SlideLayout> = LAYOUTS[layout];
	const placement = placementOf(slide);
	const { step, fits } = arrangedSlide(slide, measure);
	const held = heldInRegions(blocks, placement !== null);
	const placingOf = (index: number, width: number): Placing => {
		const region = design.regions[index];
		return {
			layout,
			part: region ? BOX_PARTS[region.box] : "flow",
			step,
			width,
			boxHeight: placement && region ? frameOfBox(placement, layout, region.box).height : undefined,
		};
	};
	const heightOf: HeightOf = (index, width) => {
		const holds = held[index] ?? [];
		return holds.length === 0 ? 0 : heightOfBlocks(holds, placingOf(index, width), measure);
	};
	const labelled = blocks.layout === "section" && blocks.shows("label");
	const { boxes, bar } = placement
		? placedRegions(design.regions, layout, placement, step, heightOf, labelled)
		: design.place({ step, heightOf, fits, labelled });
	const added = presentation.addSlide({ masterName: design.name });
	if (bar)
		added.addShape(presentation.ShapeType.rect, {
			...inchesOf(bar),
			fill: { color: ACCENT },
			objectName: ACCENT_BAR_NAME,
		});
	const unused: number[] = [];
	const placed = new Map<number, Box>();
	design.regions.forEach((region, index) => {
		const placeholder = FIRST_PLACEHOLDER_INDEX + index;
		const box = boxes[index];
		const parts = partsOf(held[index] ?? [], draw);
		const [first] = parts;
		if (!first || !box) {
			unused.push(placeholder);
			return;
		}
		const setting = settingIn(layout, BOX_PARTS[region.box], step);
		if (parts.length === 1 && first.kind === "text") {
			added.addText(textOf(paragraphsIn(first.blocks, setting)), {
				placeholder: region.name,
				fit: "shrink",
			});
			placed.set(placeholder, box);
			return;
		}
		stack(added, box, parts, setting, placingOf(index, box.w), measure);
		unused.push(placeholder);
	});
	return { notes: childNamed(slide, SPEAKER_NOTES).children, unused, boxes: placed };
}

/** Some of what a region holds, as the file draws it: text, a table, or an image, with the paragraph that holds it alone. */
type Piece =
	| { kind: "text"; blocks: readonly Node[] }
	| { kind: "table"; table: Node }
	| { kind: "image"; image: DrawableImage; alone: Node; words: string; link: unknown };

/** A piece, and whether a block's gap is between it and the part before, which it isn't between a paragraph's words and images. */
type Part = Piece & { apart: boolean };

/**
 * `blocks` as parts, one after another. A paragraph's images that the file
 * holds stand on their own, between the words before and after them, as an
 * image can't sit in a line of PowerPoint's text.
 */
function partsOf(blocks: readonly Node[], draw: ImageDrawer): Part[] {
	const parts: Part[] = [];
	for (const block of blocks) {
		blockParts(block, draw).forEach((part, index) => {
			const last = parts.at(-1);
			if (part.kind === "text" && last?.kind === "text") {
				parts[parts.length - 1] = { ...last, blocks: [...last.blocks, ...part.blocks] };
			} else {
				parts.push({ ...part, apart: index === 0 });
			}
		});
	}
	return parts;
}

function blockParts(block: Node, draw: ImageDrawer): Piece[] {
	if (block.type.name === "table") return [{ kind: "table", table: block }];
	if (block.type.name !== "paragraph" || !holdsImage(block)) {
		return [{ kind: "text", blocks: [block] }];
	}
	return paragraphParts(block, draw);
}

const holdsImage = (paragraph: Node) =>
	paragraph.children.some((child) => child.type.name === "image");

function paragraphParts(paragraph: Node, draw: ImageDrawer): Piece[] {
	const parts: Piece[] = [];
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
			alone: paragraph.copy(Fragment.from(child)),
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

/**
 * Stacks a region's parts down its box from its top, each as tall as the app
 * sets it and as far from the one before: text in boxes of its own, with room
 * to spare for Arial, tables with their rows as tall as the app's, and images
 * as large as the app draws them.
 */
function stack(
	slide: PptxGenJS.Slide,
	box: Box,
	parts: readonly Part[],
	setting: Setting,
	placing: Placing,
	measure: Measure,
) {
	let y = box.y;
	parts.forEach((part, index) => {
		if (index > 0 && part.apart) y += setting.blockGap;
		if (part.kind === "text") {
			const height = heightOfBlocks(part.blocks, placing, measure);
			if (!part.blocks.every(isEmptyParagraph)) {
				slide.addText(textOf(paragraphsIn(part.blocks, setting)), {
					...inchesOf(below(box.x, box.w, y, height)),
					valign: "top",
					margin: 0,
					fit: "shrink",
					isTextBox: true,
				});
			}
			y += height;
			return;
		}
		if (part.kind === "table") {
			const rows = tableRowHeights(part.table, rowHeightsOf(part.table, placing, measure), setting);
			const height = rows.reduce((total, row) => total + row, 0);
			slide.addTable(
				tableRowsOf(part.table, setting),
				tableOptions(part.table, { ...box, y, h: height }, rows, setting),
			);
			y += height;
			return;
		}
		const height = heightOfBlocks([part.alone], placing, measure);
		slide.addImage({
			data: part.image.data,
			...inchesOf(placedImage(part.image, { ...box, y, h: height }, setting.align)),
			altText: part.words,
			...linkTo(part.link),
		});
		y += height;
	});
}

/** `image` as large as fits in `slot` without being enlarged, a pixel to a point, at its top, across it as `align` says. */
function placedImage(image: DrawableImage, slot: Box, align: Setting["align"]): Box {
	const scale = Math.min(1, slot.w / image.width, slot.h / image.height);
	const w = image.width * scale;
	const h = image.height * scale;
	return { x: align === "center" ? slot.x + (slot.w - w) / 2 : slot.x, y: slot.y, w, h };
}

const inchesOf = ({ x, y, w, h }: Box) => ({
	x: x / POINTS_PER_INCH,
	y: y / POINTS_PER_INCH,
	w: w / POINTS_PER_INCH,
	h: h / POINTS_PER_INCH,
});

/**
 * The heights of a table's rows: as tall as the app sets them, `measured`,
 * but a line of their text tall at least, as a cell of PowerPoint's holds a
 * line even when it is empty, which the app's doesn't. A row past what is
 * measured, past as much as a slide may hold, is that line tall.
 */
function tableRowHeights(table: Node, measured: readonly number[], setting: Setting): number[] {
	const fontSize = TABLE_LOOK.text.size * setting.unit;
	const line = fontSize * TABLE_LOOK.text.lineHeight;
	return table.children.map((row, index) => {
		const height = measured[index] ?? 0;
		const header = row.firstChild?.type.name === "tableHeader";
		const padding = (header ? TABLE_LOOK.headerPadding : TABLE_LOOK.cellPadding).y * fontSize;
		return Math.max(height, 2 * padding + line + RULE_THICKNESS);
	});
}

/** A table as PowerPoint's own, filling `slot`, its columns as wide as each other, its rows `rowHeights` tall. */
function tableOptions(
	table: Node,
	slot: Box,
	rowHeights: readonly number[],
	setting: Setting,
): PptxGenJS.TableProps {
	let columns = 1;
	for (const row of table.children) columns = Math.max(columns, row.childCount);
	const { x, y, w, h } = inchesOf(slot);
	return {
		x,
		y,
		w,
		h,
		colW: Array.from({ length: columns }, () => w / columns),
		rowH: rowHeights.map((height) => height / POINTS_PER_INCH),
		fontSize: TABLE_LOOK.text.size * setting.unit,
		valign: "top",
		autoPage: false,
	};
}

/**
 * A table's rows, as the app draws them: the header row's cells grey and
 * bold on a tint, each row ruled below, and each cell padded in ems of its
 * text.
 */
function tableRowsOf(table: Node, setting: Setting): PptxGenJS.TableRow[] {
	const fontSize = TABLE_LOOK.text.size * setting.unit;
	return table.children.map((row) =>
		row.children.map((cell, index) => {
			const header = cell.type.name === "tableHeader";
			const weight = header
				? TABLE_LOOK.header.weight
				: index === 0
					? TABLE_LOOK.firstColumnWeight
					: setting.look.text.weight;
			const cellSetting: Setting = {
				...setting,
				look: {
					...setting.look,
					text: {
						...TABLE_LOOK.text,
						color: header ? TABLE_LOOK.header.color : setting.look.text.color,
						weight,
					},
				},
				fontSize,
				blockGap: TABLE_LOOK.blockGap * fontSize,
				align: "left",
			};
			const padding = header ? TABLE_LOOK.headerPadding : TABLE_LOOK.cellPadding;
			return {
				text: textOf(paragraphsIn(cell.children, cellSetting)),
				options: {
					margin: [padding.y, padding.x, padding.y, padding.x].map(
						(ems) => (ems * fontSize) / POINTS_PER_INCH,
					) as [number, number, number, number],
					border: [
						NO_BORDER,
						NO_BORDER,
						{ type: "solid", pt: RULE_THICKNESS, color: RULE },
						NO_BORDER,
					],
					...(header ? { fill: { color: TINT } } : {}),
				},
			};
		}),
	);
}

const NO_BORDER: PptxGenJS.BorderProps = { type: "none" };

/*
 * Text: each block as the app sets it in the part of the slide it is in, at
 * the slide's step, its sizes, line heights and the space between its blocks
 * and its lists' items as the app's are, so it is as tall as the app's.
 */

/** How a run of text looks. */
interface TextStyle {
	/** In points. */
	size: number;
	color: string;
	bold?: boolean;
	/** As the app's CSS gives it: a multiple of the size. */
	lineHeight: number;
}

/** `look` at `unit`: in points, bold from semibold up, as Arial is regular or bold. */
const styleOf = (look: TextLook, unit: number): TextStyle => ({
	size: look.size * unit,
	color: look.color,
	...(look.weight >= BOLD_WEIGHT ? { bold: true } : {}),
	lineHeight: look.lineHeight,
});

/** What is inherited down a region's blocks, as CSS inherits it. */
interface Setting {
	/** The look of the part of the slide the blocks are in. */
	look: PartLook;
	/** The slide's unit at its step, in points. */
	unit: number;
	/** The size the blocks are sized against, in points: the unit, or a list's text within a list. */
	fontSize: number;
	/** Between its blocks, in points. */
	blockGap: number;
	/** Whether a quote is the slide's large quote, as every one in the quote layout is. */
	quoteLayout: boolean;
	/** Whether it is a quote's, within other text: grey italics, for the rule the app draws at its side. */
	quoted: boolean;
	align: "left" | "center";
}

/** What `part` of a slide of `layout` sets its blocks with, at `step`. */
function settingIn(layout: SlideLayout, part: SlidePart, step: number): Setting {
	const look = partLook(layout, part);
	const unit = step * SLIDE_UNIT;
	return {
		look,
		unit,
		fontSize: unit,
		blockGap: look.gap * unit,
		quoteLayout: layout === "quote",
		quoted: false,
		align: alignOf(look),
	};
}

type Run = PptxGenJS.TextProps;
type RunOptions = PptxGenJS.TextPropsOptions;

/** A paragraph of PowerPoint's: its runs, its bullet or number and depth in a list, its line height and the space after it. */
interface Paragraph {
	runs: readonly Run[];
	bullet?: RunOptions["bullet"];
	level?: number;
	/** As the app's CSS gives it: a multiple of its size. */
	lineHeight: number;
	/** In points. */
	spaceAfter: number;
}

/** `blocks` as paragraphs, each block as far after the one before as `setting` sets them apart. */
const paragraphsIn = (blocks: readonly Node[], setting: Setting): Paragraph[] =>
	blocks.flatMap((block, index) =>
		paragraphsOf(block, setting, index < blocks.length - 1 ? setting.blockGap : 0),
	);

/** The look of a paragraph's runs, which each takes unless its marks say otherwise, and every one its paragraph's alignment. */
const runOptions = (style: TextStyle, setting: Setting): RunOptions => ({
	fontSize: style.size,
	color: style.color,
	...(style.bold ? { bold: true } : {}),
	...(setting.quoted ? { italic: true } : {}),
	align: setting.align,
});

/** A paragraph of `style`, `after` points before the next. */
const paragraphWith = (
	runs: readonly Run[],
	style: TextStyle,
	setting: Setting,
	after: number,
): Paragraph => ({
	runs: runs.length > 0 ? runs : [{ text: "", options: runOptions(style, setting) }],
	lineHeight: style.lineHeight,
	spaceAfter: after,
});

/**
 * A block as PowerPoint's paragraphs, the last `after` points before what
 * follows. A list's items are its bullets or numbers, an item's own blocks
 * the lines of its paragraph and a list in it the level below; a quote is its
 * blocks in grey italics, or the slide's large quote in the quote layout; a
 * code block is its lines in a monospace font; and a table within something
 * else, which PowerPoint can't hold in text, is a line for each row, its cells
 * apart by a tab. Anything else is its text.
 */
function paragraphsOf(block: Node, setting: Setting, after: number): Paragraph[] {
	const { look, unit } = setting;
	switch (block.type.name) {
		case "heading":
			return [headingParagraph(block, setting, after)];
		case "bulletList":
		case "orderedList":
			return listParagraphs(block, setting, after, 0);
		case "blockquote":
			return quoteParagraphs(block, setting, after);
		case "codeBlock": {
			const style: TextStyle = {
				size: CODE_LOOK.blockScale * look.text.size * unit,
				color: TEXT,
				lineHeight: look.text.lineHeight,
			};
			return [paragraphWith(codeRuns(block, runOptions(style, setting)), style, setting, after)];
		}
		case "table": {
			const style = styleOf(look.text, unit);
			return block.children.map((row, index) =>
				paragraphWith(
					rowRuns(row, setting),
					style,
					setting,
					index === block.childCount - 1 ? after : 0,
				),
			);
		}
		default: {
			const style = styleOf(setting.quoted ? quotedLook(look.text) : look.text, unit);
			const base = runOptions(style, setting);
			const runs = block.isTextblock
				? runsOf(block, base)
				: [{ text: block.textContent, options: { ...base } }];
			return [paragraphWith(runs, style, setting, after)];
		}
	}
}

const quotedLook = (look: TextLook): TextLook => ({ ...look, color: BLOCK_QUOTE_LOOK.color });

/**
 * Headings up to the third in the part's heading look, with the room under
 * them the app's rule under a column's heading takes; those below are the
 * size and weight of what is around them.
 */
function headingParagraph(heading: Node, setting: Setting, after: number): Paragraph {
	const { look, unit } = setting;
	if ((Number(heading.attrs.level) || 1) > 3) {
		const style: TextStyle = {
			size: setting.fontSize,
			color: TEXT,
			lineHeight: look.text.lineHeight,
		};
		return paragraphWith(runsOf(heading, runOptions(style, setting)), style, setting, after);
	}
	const style = { ...styleOf(look.heading, unit), color: TEXT };
	const rule = look.ruledHeadings ? COLUMN_LOOK.headingRuleGap * style.size + RULE_THICKNESS : 0;
	return paragraphWith(runsOf(heading, runOptions(style, setting)), style, setting, rule + after);
}

const isList = (block: Node) => ["bulletList", "orderedList"].includes(block.type.name);

/** A list's items, as far apart as the part sets them, a list in an item a little below it. */
function listParagraphs(list: Node, setting: Setting, after: number, level: number): Paragraph[] {
	const fontSize = setting.look.text.size * setting.unit;
	const itemSetting = { ...setting, fontSize };
	const style = styleOf(
		setting.quoted ? quotedLook(setting.look.text) : setting.look.text,
		setting.unit,
	);
	const nestedGap = LIST_LOOK.nestedGap * fontSize;
	return list.children.flatMap((item, index) => {
		const afterItem = index < list.childCount - 1 ? setting.look.listGap * fontSize : after;
		const lines = item.children
			.filter((child) => !isList(child))
			.flatMap((child) => paragraphsOf(child, itemSetting, 0).map(({ runs }) => runs));
		const nested = item.children.filter(isList);
		return [
			{
				runs: joinedLines(lines, runOptions(style, itemSetting)),
				bullet: bulletOf(list, fontSize, level),
				level,
				lineHeight: style.lineHeight,
				spaceAfter: nested.length > 0 ? nestedGap : afterItem,
			},
			...nested.flatMap((child, nestedIndex) =>
				listParagraphs(
					child,
					itemSetting,
					nestedIndex < nested.length - 1 ? nestedGap : afterItem,
					level + 1,
				),
			),
		];
	});
}

function bulletOf(list: Node, fontSize: number, level: number): RunOptions["bullet"] {
	const indent = fontSize * LIST_LOOK.indent;
	if (list.type.name === "orderedList") {
		return { type: "number", indent, numberStartAt: Number(list.attrs.start) || 1 };
	}
	return { indent, characterCode: BULLET_CHARACTERS[level % BULLET_CHARACTERS.length] };
}

/** A quote's blocks one under another: in the quote layout, the slide's large quote; elsewhere, grey italics. */
function quoteParagraphs(quote: Node, setting: Setting, after: number): Paragraph[] {
	const inner: Setting = setting.quoteLayout
		? { ...setting, look: { ...setting.look, text: QUOTE_LOOK }, blockGap: 0 }
		: { ...setting, blockGap: 0, quoted: true };
	const paragraphs = paragraphsIn(quote.children, inner);
	const last = paragraphs.at(-1);
	if (!last) return [];
	return [...paragraphs.slice(0, -1), { ...last, spaceAfter: last.spaceAfter + after }];
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
			...(index > 0 ? { softBreakBefore: true } : {}),
		},
	}));
}

function rowRuns(row: Node, setting: Setting): Run[] {
	const base = runOptions(styleOf(setting.look.text, setting.unit), setting);
	return row.children.flatMap((cell, index) => [
		...(index > 0 ? [{ text: "\t", options: { ...base } }] : []),
		...joinedLines(
			paragraphsIn(cell.children, setting).map(({ runs }) => runs),
			base,
		),
	]);
}

/** A textblock's line as runs of `base`, each with its marks. An image in it is its words. */
function runsOf(textblock: Node, base: RunOptions): Run[] {
	return textblock.children.map((inline) => {
		const options = { ...base, ...markOptions(inline.marks, base) };
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

const markOptions = (marks: readonly Mark[], base: RunOptions): RunOptions =>
	Object.assign({}, ...marks.map((mark) => MARK_OPTIONS[mark.type.name]?.(mark, base) ?? {}));

const MARK_OPTIONS: Readonly<Record<string, (mark: Mark, base: RunOptions) => RunOptions>> = {
	bold: () => ({ bold: true }),
	italic: () => ({ italic: true }),
	strike: () => ({ strike: "sngStrike" }),
	underline: () => ({ underline: { style: "sng" } }),
	code: (_mark, base) => ({
		fontFace: CODE_FONT,
		fontSize: (base.fontSize ?? 0) * CODE_LOOK.inlineScale,
	}),
	superscript: () => ({ superscript: true }),
	subscript: () => ({ subscript: true }),
	highlight: () => ({ highlight: HIGHLIGHT_YELLOW }),
	link: (mark) => linkTo(mark.attrs.href),
};

/**
 * A link to `href`, when it goes somewhere a link in a file may (`linkInFile`).
 * A link keeps its text's colour and is underlined, as the app draws one.
 */
const linkTo = (href: unknown): { hyperlink?: PptxGenJS.HyperlinkProps } => {
	const url = linkInFile(href);
	return url ? { hyperlink: { url } } : {};
};

/**
 * Paragraphs as PptxGenJS's runs: each paragraph's bullet, depth, line
 * spacing and space after on its first run, which PowerPoint takes the
 * paragraph's from, and a break after its last.
 */
function textOf(paragraphs: readonly Paragraph[]): Run[] {
	return paragraphs.flatMap(({ runs, bullet, level, lineHeight, spaceAfter }) => {
		const [first = { text: "" }, ...rest] = runs;
		const all = [
			{
				...first,
				options: {
					...first.options,
					bullet,
					...(level ? { indentLevel: level } : {}),
					lineSpacingMultiple: lineHeight / ARIAL_LINE_HEIGHT,
					...(spaceAfter > 0 ? { paraSpaceAfter: spaceAfter } : {}),
				},
			},
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
 * their properties once and their end marks the size of their text, each
 * shape with an id of its own, an image without words given none, each
 * placeholder where the slide places its text and none the slide shows
 * nothing in, and a section break's accent bar marked as decorative, which
 * PptxGenJS has no option for; each slide's notes as their paragraphs, which
 * it writes as one run; each layout's placeholders with their text's edge, no
 * padding and text that shrinks to fit, so a slide made from one in
 * PowerPoint is laid out as the deck's are; the master's styles as the app
 * sets text; no layout but the deck's; and no entries for folders.
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
					withPlaceholdersAt(
						withoutPlaceholders(
							withEndMarksSizedAsTheirText(
								withParagraphPropertiesOnce(
									withAccentBarDecorative(xml.replaceAll(MADE_UP_IMAGE_WORDS, "")),
								),
							),
							slide.unused,
						),
						slide.boxes,
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
		rewritten(zip, MASTER, withTextStylesAsTheApp),
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

const MASTER = "ppt/slideMasters/slideMaster1.xml";

async function rewritten(zip: JSZip, path: string, change: (xml: string) => string) {
	const part = zip.file(path);
	if (!part) throw new Error(`PptxGenJS wrote no ${path}`);
	zip.file(path, change(await part.async("string")));
}

/** The words PptxGenJS gives an image that has none, the name it files an image's bytes under. */
const MADE_UP_IMAGE_WORDS = ' descr="preencoded.png"';

/** What a section break's accent bar is named, as PowerPoint's Selection Pane lists it. */
const ACCENT_BAR_NAME = "Accent bar";

/**
 * PowerPoint's mark for a shape that only decorates the slide, which a screen
 * reader passes over and an import doesn't count as left out. PowerPoint
 * reads it only under this extension's id.
 */
const DECORATIVE_MARK =
	'<a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" val="1"/></a:ext></a:extLst>';

/** `xml` with the accent bar marked as decorative, inside the properties PptxGenJS writes empty for a shape without a link. */
const withAccentBarDecorative = (xml: string) =>
	xml.replace(
		new RegExp(`(<p:cNvPr id="\\d+" name="${ACCENT_BAR_NAME}">)(</p:cNvPr>)`),
		`$1${DECORATIVE_MARK}$2`,
	);

/** A paragraph's properties, which PptxGenJS writes before each of its runs, and PowerPoint reads once, first. */
const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g;

const PARAGRAPH = /<a:p>[\s\S]*?<\/a:p>/g;

const withParagraphPropertiesOnce = (xml: string) =>
	xml.replace(PARAGRAPH, (paragraph) => {
		let first = true;
		return paragraph.replace(PARAGRAPH_PROPERTIES, (properties) => {
			const kept = first ? properties : "";
			first = false;
			return kept;
		});
	});

/**
 * `xml` with each paragraph's end mark the size of its last run, which
 * PptxGenJS gives the first size its box was given, and which a presentation
 * program may make the paragraph's last line as tall as.
 */
const withEndMarksSizedAsTheirText = (xml: string) =>
	xml.replace(PARAGRAPH, (paragraph) => {
		const size = [...paragraph.matchAll(/<a:rPr\b[^>]*?\bsz="(\d+)"/g)].at(-1)?.[1];
		if (!size) return paragraph;
		return paragraph.replace(/(<a:endParaRPr\b[^>]*?\bsz=")\d+"/, `$1${size}"`);
	});

/** `xml` with each of its shapes changed by `change`. A slide or layout of PptxGenJS's holds no shape in another. */
const eachShape = (xml: string, change: (shape: string) => string) =>
	xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, change);

const placeholderIndexOf = (shape: string) =>
	Number(/<p:ph\b[^>]*\bidx="(\d+)"/.exec(shape)?.[1] ?? Number.NaN);

/** `xml` without the placeholders numbered `indexes`, which PptxGenJS adds to a slide empty where it was given nothing for them. */
const withoutPlaceholders = (xml: string, indexes: readonly number[]) =>
	eachShape(xml, (shape) => (indexes.includes(placeholderIndexOf(shape)) ? "" : shape));

/** `xml` with each placeholder numbered in `boxes` in its box there, which PptxGenJS puts where its layout's is. */
const withPlaceholdersAt = (xml: string, boxes: ReadonlyMap<number, Box>) =>
	eachShape(xml, (shape) => {
		const box = boxes.get(placeholderIndexOf(shape));
		if (!box) return shape;
		const [x, y, w, h] = [box.x, box.y, box.w, box.h].map((points) =>
			Math.round(points * EMUS_PER_POINT),
		);
		return shape.replace(
			/<a:xfrm><a:off x="\d+" y="\d+"\/><a:ext cx="\d+" cy="\d+"\/><\/a:xfrm>/,
			`<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`,
		);
	});

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

const withRegionsLaidOut = (xml: string, regions: readonly Region<SlideLayout>[]) =>
	eachShape(xml, (shape) => {
		const region = regions[placeholderIndexOf(shape) - FIRST_PLACEHOLDER_INDEX];
		if (!region) return shape;
		const anchor = region.anchor === "top" ? "t" : "b";
		return shape.replace(
			LAYOUT_BODY_PROPERTIES,
			`<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr>`,
		);
	});

/**
 * The master's text styles, which PptxGenJS writes as PowerPoint's default,
 * as the app sets text: a title at the left, not centred, and no space before
 * a paragraph of a body's, whose space after each paragraph is all the app
 * sets between them. Every paragraph the file holds states these itself, but
 * text a presentation program adds takes them from here.
 */
const withTextStylesAsTheApp = (xml: string) =>
	xml
		.replace(/(<p:titleStyle>\s*<a:lvl1pPr\b[^>]*?\balgn=")ctr"/, '$1l"')
		.replace(/(<p:bodyStyle>[\s\S]*?<\/p:bodyStyle>)/, (bodyStyle) =>
			bodyStyle.replaceAll(
				'<a:spcBef><a:spcPct val="20000"/></a:spcBef>',
				'<a:spcBef><a:spcPts val="0"/></a:spcBef>',
			),
		);

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
		rewritten(zip, MASTER, (xml) =>
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
