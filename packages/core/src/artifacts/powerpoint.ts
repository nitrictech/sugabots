import {
	type Artifact,
	type ArtifactImageType,
	MAX_ARTIFACT_IMAGES_BYTES,
} from "@sugabots/contracts";
import type { ArtifactImageIds } from "@sugabots/contracts/http";
import { backgroundOf, bodyOf, layoutOf, notesOf } from "@sugabots/contracts/live-slides";
import type { BoxAttributes, BoxRole } from "@sugabots/contracts/slide-box";
import { type Frame, SLIDE_UNIT } from "@sugabots/contracts/slide-geometry";
import { defaultFrameOf, type SlideLayout } from "@sugabots/contracts/slide-layouts";
import { pathCommandsOf, type SvgPath } from "@sugabots/contracts/svg-path";
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
	alignedOffset,
	BACKGROUND,
	BLOCK_QUOTE_LOOK,
	BOLD_WEIGHT,
	type BoxLook,
	boxLookOf,
	CODE_LOOK,
	COLUMN_LOOK,
	cellInsetOf,
	contentAreaOf,
	type DeckImage,
	drawnAttributesOf,
	fittedImage,
	type GridCell,
	hasAccentBar,
	type ImageFit,
	imageFillingBox,
	imageFitOf,
	insetsOf,
	isEmptyTextblock,
	isTurned,
	LAYOUT_LOOKS,
	LIST_LOOK,
	lineHeightOf,
	linkInFile,
	listStartOf,
	type OwnTextStyle,
	outlineInsetOf,
	ownImagesIn,
	ownTextStyleOf,
	type Paint,
	paintOf,
	piecesOfTextblock,
	QUOTE_LOOK,
	RULE,
	RULE_THICKNESS,
	type ShapeLook,
	shapeLookOf,
	TABLE_LOOK,
	TEXT,
	TEXT_SIZES,
	type TextAlign,
	type TextLook,
	TINT,
	tableGridOf,
	textAlignOf,
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
 * the artifact is, 16:9, a slide for each of the deck's in order, on its
 * background, or white. Each box is a shape at its frame, in the order the
 * slide holds them, turned as it is turned: filled and outlined as it is, its
 * path as PowerPoint's own freeform, and what it holds within its padding,
 * where its vertical alignment sits it. A slide's first title box that holds
 * only text, or else its quote, is its title placeholder, which PowerPoint's
 * outline and screen readers take for the slide's title. Every slide is on
 * one layout, which holds a title alone where the app puts a new slide's.
 *
 * Text keeps its bold, italics, underline, strikethrough, superscript,
 * subscript, highlight, inline code and links, its own colour, size and font,
 * and its paragraphs' alignment and line height. Text that says nothing of
 * its own look is set as the app sets text of its box's role
 * (`slide-design.ts`), in Arial, at the step the app draws its slide's text
 * at, the largest of its steps at which the slide fits, as the PDF finds it
 * (`slide-layout.ts`). Lists are PowerPoint's own at their depth, numbered
 * from 1 at least, and a slide's speaker notes are its notes. A table is
 * PowerPoint's own, on its grid (`tableGridOf`). An image the deck keeps is
 * held in the file, as `imageOf` gives it, with its words, when it is a PNG,
 * JPEG or GIF; any other image comes out as its words. A quote is its
 * paragraphs in grey italics, and a code block its lines in a monospace font.
 *
 * PowerPoint's text holds no table or picture, so a box holding either is its
 * shape with what it holds stacked on it, each piece as tall as the app sets
 * it, its text in boxes of its own; each piece turns with the box, but for a
 * table, which PowerPoint doesn't turn. A paragraph or heading holding a
 * picture is its words and pictures on lines of their own, as the PDF draws
 * them; a picture in a list, a quote or a table is its words, measured as
 * them.
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

/** Fonts every copy of PowerPoint has, which the app's own isn't. */
const FONT = "Arial";
const CODE_FONT = "Courier New";

/** The yellow a highlight is, PowerPoint's own highlighter colour. */
const HIGHLIGHT_YELLOW = "FFFF00";

/**
 * The height of a line of Arial at 100% line spacing, as a multiple of its
 * size, which PowerPoint's line spacing is a share of, as CSS's isn't. Text
 * in another font is spaced by it too, as near as a share of a line can say
 * CSS's line height without knowing the font.
 */
const ARIAL_LINE_HEIGHT = 1.15;

/**
 * How much taller than the app's measure of its text a box of text stacked
 * on a box is made, as a share of that height, for the text set in Arial
 * rather than the app's Rubik. Arial runs 1 to 7% narrower than Rubik on a
 * slide's words, and wraps them in no more lines, but a line of wide
 * capitals can run 5% wider, and a program that takes Arial's single line
 * spacing as 1.2 times its size, rather than the 1.15 it is, sets lines 4%
 * further apart.
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

/** A box on a slide, and how far it is turned clockwise about its middle, in degrees. */
interface Placed extends Box {
	rotate?: number;
}

/** The least a shape is across or down, in points: PowerPoint scales a freeform's path by its size, which mustn't be none. */
const THINNEST = 0.01;

const boxOf = ({ x, y, width, height }: Frame): Box => ({ x, y, w: width, h: height });

/** Text `height` tall, with Arial's allowance. */
const grown = (height: number) => height * (1 + ARIAL_ALLOWANCE);

/**
 * PptxGenJS reads a number of 100 or more as a length in the file's own
 * units, not inches, so every position, size and point is kept within this
 * many inches, much further than anything on a slide reaches.
 */
const FURTHEST_POINT = 99;

/** `points` in inches, within `FURTHEST_POINT`. */
const inches = (points: number) =>
	Math.max(-FURTHEST_POINT, Math.min(FURTHEST_POINT, points / POINTS_PER_INCH));

const inchesOf = ({ x, y, w, h }: Box) => ({
	x: inches(x),
	y: inches(y),
	w: Math.max(0, inches(w)),
	h: Math.max(0, inches(h)),
});

/** `placed` as PptxGenJS takes it: in inches, turned between 0 and 360 degrees, as PowerPoint writes a turn. */
const positionOf = ({ rotate = 0, ...box }: Placed) => ({
	...inchesOf(box),
	...(isTurned(rotate) ? { rotate: ((rotate % 360) + 360) % 360 } : {}),
});

/**
 * `box`, on a box at `frame` turned `degrees` clockwise about its middle, as
 * PowerPoint places it, as it turns each shape about its own middle: its
 * middle turned about the frame's, and itself turned as much.
 */
function turnedWith(box: Box, frame: Frame, degrees: number): Placed {
	if (!isTurned(degrees)) return box;
	const radians = (degrees * Math.PI) / 180;
	const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
	const across = box.x + box.w / 2 - centre.x;
	const down = box.y + box.h / 2 - centre.y;
	return {
		x: centre.x + across * Math.cos(radians) - down * Math.sin(radians) - box.w / 2,
		y: centre.y + across * Math.sin(radians) + down * Math.cos(radians) - box.h / 2,
		w: box.w,
		h: box.h,
		rotate: degrees,
	};
}

/** How transparent `paint` is, as PowerPoint says it: a percentage. */
const transparencyOf = ({ opacity }: Paint) => Math.round((1 - opacity) * 100);

/** An image the file can hold: as PptxGenJS takes it, with its size in pixels. */
interface DrawableImage {
	data: string;
	/** Its size as it is stored. */
	width: number;
	height: number;
	/** How it is turned and mirrored to show upright, as its EXIF orientation says (`ORIENTATIONS`). */
	orientation: Orientation;
	/** Its size as it is shown, upright, which its orientation may turn on its side. */
	upright: Size;
	byteLength: number;
}

/**
 * How PowerPoint shows a picture upright, as a browser shows it by its EXIF
 * orientation, by the orientation's number: the picture mirrored across, or
 * down, and then turned clockwise. PowerPoint draws a picture's pixels as
 * they are stored, and mirrors a shape before it turns it, as EXIF's
 * orientations do: 5 is mirrored and turned three quarters, and 7 mirrored
 * and turned a quarter.
 */
const ORIENTATIONS = {
	1: { rotate: 0 },
	2: { rotate: 0, flipH: true },
	3: { rotate: 180 },
	4: { rotate: 0, flipV: true },
	5: { rotate: 270, flipH: true },
	6: { rotate: 90 },
	7: { rotate: 90, flipH: true },
	8: { rotate: 270 },
} as const satisfies Record<number, { rotate: number; flipH?: true; flipV?: true }>;

type Orientation = keyof typeof ORIENTATIONS;

const orientationIn = (value: unknown): Orientation =>
	typeof value === "number" && value in ORIENTATIONS ? (value as Orientation) : 1;

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
	const { width, height, orientation } = size;
	const stored = orientation === 1 ? bytes : withOrientationUpright(bytes);
	return {
		data: `${contentType};base64,${Buffer.from(stored).toString("base64")}`,
		width,
		height,
		orientation,
		upright: isSideways(orientation) ? { width: height, height: width } : { width, height },
		byteLength: bytes.byteLength,
	};
}

function sizeOf(
	bytes: Uint8Array,
): { width: number; height: number; orientation: Orientation } | undefined {
	try {
		const { width, height, orientation } = imageSize(bytes);
		return width && height ? { width, height, orientation: orientationIn(orientation) } : undefined;
	} catch {
		return undefined;
	}
}

/** A JPEG's markers: the start of its scan, after which no more of its headers come, and an APP1 segment, which may hold its EXIF. */
const START_OF_SCAN = 0xda;
const APP1 = 0xe1;

/** The tag of EXIF's orientation, and the orientation that shows a picture as it is stored. */
const ORIENTATION_TAG = 0x0112;
const AS_STORED = 1;

/**
 * A copy of `bytes`, a JPEG's, whose EXIF says its orientation is as it is
 * stored, its pixels as they were: the file turns and mirrors the picture
 * itself (`pictureAt`), which a program that turns a picture by its EXIF, as
 * some do, would otherwise do a second time. `bytes` itself when it says no
 * orientation.
 */
function withOrientationUpright(bytes: Uint8Array): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff; ) {
		const marker = bytes[at + 1];
		const length = view.getUint16(at + 2);
		if (marker === START_OF_SCAN) break;
		const tiff = at + 10;
		const isExif =
			marker === APP1 && String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === "Exif";
		if (isExif && tiff + 8 <= bytes.length) {
			const little = bytes[tiff] === 0x49;
			const directory = tiff + view.getUint32(tiff + 4, little);
			const entries = directory + 2 <= bytes.length ? view.getUint16(directory, little) : 0;
			for (let entry = directory + 2; entry < directory + 2 + entries * 12; entry += 12) {
				if (entry + 12 > bytes.length) break;
				if (view.getUint16(entry, little) !== ORIENTATION_TAG) continue;
				const copy = new Uint8Array(bytes);
				new DataView(copy.buffer).setUint16(entry + 8, AS_STORED, little);
				return copy;
			}
		}
		at += 2 + length;
	}
	return bytes;
}

/** Whether a picture of `orientation` is turned on its side to show upright, its width and height swapped. */
const isSideways = (orientation: Orientation) => ORIENTATIONS[orientation].rotate % 180 !== 0;

/**
 * Where `image` goes to show upright across `shown`, on a box at `frame`
 * turned `degrees` clockwise about its middle, as PptxGenJS places a picture:
 * its stored pixels across a box of their own shape, about the middle the
 * box's turn takes `shown`'s to, mirrored and turned as its orientation says
 * and turned with the box.
 */
function pictureAt(image: DrawableImage, shown: Box, frame: Frame, degrees: number) {
	const turned = turnedWith(shown, frame, degrees);
	const { rotate, ...flips } = ORIENTATIONS[image.orientation];
	const [w, h] = isSideways(image.orientation) ? [turned.h, turned.w] : [turned.w, turned.h];
	const middle = { x: turned.x + turned.w / 2, y: turned.y + turned.h / 2 };
	return {
		...positionOf({
			x: middle.x - w / 2,
			y: middle.y - h / 2,
			w,
			h,
			rotate: (turned.rotate ?? 0) + rotate,
		}),
		...flips,
	};
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

/** What the file's own forms need to know of each slide once PptxGenJS has written it (`withPowerPointsOwnForms`). */
interface DrawnSlide {
	/** Its speaker notes' paragraphs. */
	notes: readonly Node[];
	/** Whether a box of it is its title placeholder (`TITLE_NAME`). */
	titled: boolean;
	/** How many section break accent bars it holds (`ACCENT_BAR_NAME`). */
	accentBars: number;
}

/** The layout every slide is on, as PowerPoint names one holding a title alone. */
const LAYOUT_NAME = "Title Only";

/** What the box that is a slide's title placeholder is named while PptxGenJS writes it, which `withTitlePlaceholder` finds it by. */
const TITLE_NAME = "Title";

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
	presentation.title = xmlText(title);
	presentation.author = "";
	presentation.company = "";
	presentation.subject = "";
	presentation.theme = { headFontFace: FONT, bodyFontFace: FONT };
	presentation.defineSlideMaster(titleOnlyLayout());
	const slides = deck.children.map((slide) => addSlide(presentation, slide, draw, measure));
	return { presentation, slides };
}

/**
 * The one layout of the file: a title where the app puts a new slide's, in
 * the look of the app's, which a slide made in PowerPoint starts with.
 */
function titleOnlyLayout(): PptxGenJS.SlideMasterProps {
	const look = LAYOUT_LOOKS.bullets.heading;
	return {
		title: LAYOUT_NAME,
		background: { color: BACKGROUND },
		objects: [
			{
				placeholder: {
					options: {
						name: "title",
						type: "title",
						...inchesOf(boxOf(defaultFrameOf("title", "bullets"))),
						fontSize: look.size * SLIDE_UNIT,
						color: look.color,
						bold: look.weight >= BOLD_WEIGHT,
						align: "left",
						valign: "top",
					},
					text: "Title",
				},
			},
		],
	};
}

function addSlide(
	presentation: PptxGenJS,
	slide: Node,
	draw: ImageDrawer,
	measure: Measure,
): DrawnSlide {
	const layout = layoutOf(slide);
	const { step } = arrangedSlide(slide, measure);
	const added = presentation.addSlide({ masterName: LAYOUT_NAME });
	const background = paintOf(backgroundOf(slide));
	if (background) {
		added.background = { color: background.color, transparency: transparencyOf(background) };
	}
	const boxes = bodyOf(slide).children.map((box): BoxToAdd => {
		const alone = imageFillingBox(box);
		const image = alone && draw(alone.attrs.src);
		const blocks = writtenOf(box.children).map((block) =>
			HOLDING_NO_PICTURE.has(block.type.name) ? picturesAsWords(block) : block,
		);
		return {
			attributes: drawnAttributesOf(box),
			filling: alone && image ? { image, words: wordsOf(alone) } : undefined,
			parts: image ? [] : partsOf(blocks, draw),
		};
	});
	const title = titleBoxIn(boxes);
	boxes.forEach((box, index) => {
		addBox(added, box, { layout, step, title: index === title }, measure);
	});
	return {
		notes: notesOf(slide).children,
		titled: title !== -1,
		accentBars: boxes.filter(({ attributes }) => hasAccentBar(layout, attributes.role)).length,
	};
}

/**
 * The blocks in which PowerPoint's text holds no picture, nor can a picture
 * be set apart from their text as one is from a paragraph's (`partsOf`): a
 * list, a quote and a table. A picture in one is its words (`picturesAsWords`).
 */
const HOLDING_NO_PICTURE = new Set(["bulletList", "orderedList", "blockquote", "table"]);

/**
 * `block` with each picture in it as its words, keeping its link, so what
 * PowerPoint shows of it is what is measured: nothing, for a picture without
 * words.
 */
function picturesAsWords(block: Node): Node {
	const { schema } = block.type;
	if (!block.isTextblock) {
		return block.copy(Fragment.fromArray(block.children.map(picturesAsWords)));
	}
	const inline = block.children.flatMap((child) => {
		if (child.type.name !== "image") return [child];
		const words = String(child.attrs.alt ?? "");
		const link: unknown = child.attrs.link;
		const marks =
			typeof link === "string" && schema.marks.link
				? schema.marks.link.create({ href: link }).addToSet(child.marks)
				: child.marks;
		return words === "" ? [] : [schema.text(words, marks)];
	});
	return block.copy(Fragment.fromArray(inline));
}

/**
 * One of a slide's boxes: how it is drawn, and what it holds, as the file
 * draws it: the image filling it (`imageFillingBox`), or its parts.
 */
interface BoxToAdd {
	attributes: BoxAttributes;
	filling: { image: DrawableImage; words: string } | undefined;
	parts: readonly Part[];
}

/** What the file writes of `blocks`, what a box holds: nothing when they are only empty paragraphs and headings, which show nothing (`isEmptyTextblock`). */
const writtenOf = (blocks: readonly Node[]) => (blocks.every(isEmptyTextblock) ? [] : blocks);

/**
 * Which of a slide's `boxes` is its title placeholder: its first title box
 * that holds text alone, or, on a slide with none, its first such quote box,
 * as PowerPoint's own quote layouts make the quote the title. `-1` for none.
 */
function titleBoxIn(boxes: readonly BoxToAdd[]): number {
	const firstHolding = (role: BoxRole) =>
		boxes.findIndex(({ attributes, parts }) => attributes.role === role && textAlone(parts));
	const title = firstHolding("title");
	return title === -1 ? firstHolding("quote") : title;
}

/** The blocks `parts` hold when they are one piece of text alone: `undefined` when they are anything else. */
function textAlone(parts: readonly Part[]): readonly Node[] | undefined {
	const [only, ...more] = parts;
	return only?.kind === "text" && more.length === 0 ? only.blocks : undefined;
}

/**
 * `box` on `slide`: as its shape with the image filling it over it; as one
 * shape holding its text when that is all it holds; or as its shape with
 * each part of what it holds stacked on it (`stack`). A box that draws
 * nothing and holds nothing is left out, but for the section break's accent
 * bar, which is over its label, empty or not.
 */
function addBox(
	slide: PptxGenJS.Slide,
	{ attributes, filling, parts }: BoxToAdd,
	{ layout, step, title }: { layout: SlideLayout; step: number; title: boolean },
	measure: Measure,
) {
	const { frame, role, rotation, verticalAlign } = attributes;
	const look = shapeLookOf(attributes);
	const drawn = look.fill !== undefined || look.stroke !== undefined;
	if (filling) {
		if (drawn) slide.addShape(look.path ? FREEFORM : "rect", shapeOptions(attributes, look));
		addFillingPicture(slide, filling, attributes, imageFitOf(layout));
		return;
	}
	const setting = settingIn(layout, role, step);
	const addAccentBar = () => {
		if (!hasAccentBar(layout, role)) return;
		slide.addShape("rect", {
			...positionOf(turnedWith(boxOf(accentBarOver(frame, setting.unit)), frame, rotation)),
			fill: { color: ACCENT },
			objectName: ACCENT_BAR_NAME,
		});
	};
	const text = parts.length === 0 ? [] : textAlone(parts);
	if (text) {
		if (text.length > 0 || drawn) {
			slide.addText(textOf(paragraphsIn(text, setting)), {
				...shapeOptions(attributes, look),
				margin: textInsetsOf(attributes, look),
				valign: verticalAlign,
				isTextBox: !drawn && !look.path,
				...(title ? { objectName: TITLE_NAME } : {}),
			});
		}
		addAccentBar();
		return;
	}
	if (drawn) slide.addShape(look.path ? FREEFORM : "rect", shapeOptions(attributes, look));
	addAccentBar();
	const area = contentAreaOf(attributes);
	const placing: Placing = { layout, role, step, width: area.width };
	stack(slide, { ...attributes, area }, parts, setting, placing, measure);
}

/**
 * The longer side of the shape PptxGenJS is told a picture has when it crops
 * one, in inches: it reads only the shape's proportions, and reads a number as
 * inches only below 100.
 */
const SHAPE_TO_CROP = 10;

/**
 * `image` filling the content area of a box drawn as `attributes` say, as
 * `fit` says (`imageFitOf`), turned with the box: whole within it, as large
 * as fits, or over all of it, its picture cropped about its middle to it.
 */
function addFillingPicture(
	slide: PptxGenJS.Slide,
	{ image, words }: { image: DrawableImage; words: string },
	attributes: BoxAttributes,
	fit: ImageFit,
) {
	const { frame, rotation } = attributes;
	const area = contentAreaOf(attributes);
	// PptxGenJS gives a picture of no width or height a size of its own, where the app draws nothing.
	if (!(area.width > 0 && area.height > 0)) return;
	if (fit === "contain") {
		const shown = boxOf(fittedImage(image.upright, area, "contain"));
		slide.addImage({
			data: image.data,
			...pictureAt(image, shown, frame, rotation),
			altText: words,
		});
		return;
	}
	const placed = pictureAt(image, boxOf(area), frame, rotation);
	const longest = Math.max(image.width, image.height);
	slide.addImage({
		data: image.data,
		...placed,
		w: (SHAPE_TO_CROP * image.width) / longest,
		h: (SHAPE_TO_CROP * image.height) / longest,
		sizing: { type: "cover", w: placed.w, h: placed.h },
		altText: words,
	});
}

/** PptxGenJS's freeform, drawn from its `points`, which its typings leave out of the shapes it names. */
const FREEFORM = "custGeom" as PptxGenJS.SHAPE_NAME;

/** A box's own shape as PptxGenJS draws it: at its frame, turned, its path a freeform, filled and outlined. */
type ShapeOptions = Pick<
	PptxGenJS.ShapeProps,
	"x" | "y" | "w" | "h" | "rotate" | "fill" | "line" | "points"
> & { shape?: PptxGenJS.SHAPE_NAME };

/**
 * `attributes`' shape as PptxGenJS draws it, as `look` says: a freeform of
 * its path at its frame, or its frame's rectangle, its outline drawn within
 * the frame as the app draws it, as PowerPoint draws a rectangle's on its
 * edge.
 */
function shapeOptions(attributes: BoxAttributes, look: ShapeLook): ShapeOptions {
	const { frame, rotation } = attributes;
	const inset = outlineInsetOf(look) / 2;
	const box = {
		x: frame.x + inset,
		y: frame.y + inset,
		w: Math.max(THINNEST, frame.width - 2 * inset),
		h: Math.max(THINNEST, frame.height - 2 * inset),
	};
	return {
		...positionOf({ ...box, rotate: rotation }),
		...(look.path ? { shape: FREEFORM, points: pointsOf(look.path) } : {}),
		...(look.fill
			? { fill: { color: look.fill.color, transparency: transparencyOf(look.fill) } }
			: {}),
		...(look.stroke
			? {
					line: {
						color: look.stroke.paint.color,
						transparency: transparencyOf(look.stroke.paint),
						width: look.stroke.width,
					},
				}
			: {}),
	};
}

/**
 * How far in from the edges of the shape `shapeOptions` draws a box's text
 * starts, in points, as PptxGenJS 4 reads a text box's margin, whatever its
 * typings say: left, right, bottom, top.
 */
function textInsetsOf(
	attributes: BoxAttributes,
	look: ShapeLook,
): [number, number, number, number] {
	const shapeInset = outlineInsetOf(look) / 2;
	const { top, right, bottom, left } = insetsOf(attributes);
	return [left - shapeInset, right - shapeInset, bottom - shapeInset, top - shapeInset];
}

/** Some of what a box holds, as the file draws it: text, a table, or an image, with the paragraph that holds it alone. */
type Piece =
	| { kind: "text"; blocks: readonly Node[] }
	| { kind: "table"; table: Node }
	| { kind: "image"; image: DrawableImage; alone: Node; words: string; link: unknown };

/** A piece, and whether a block's gap is between it and the part before, which it isn't between the pieces of a paragraph. */
type Part = Piece & { apart: boolean };

/**
 * `blocks` as parts, one after another, the blocks of text between tables and
 * images together. A paragraph or heading holding an image is in pieces
 * (`piecesOfTextblock`), as an image can't sit in a line of PowerPoint's text.
 */
function partsOf(blocks: readonly Node[], draw: ImageDrawer): Part[] {
	const parts: Part[] = [];
	for (const block of blocks) {
		blockParts(block, draw).forEach((part, index) => {
			const last = parts.at(-1);
			const apart = index === 0;
			if (apart && part.kind === "text" && last?.kind === "text") {
				parts[parts.length - 1] = { ...last, blocks: [...last.blocks, ...part.blocks] };
			} else {
				parts.push({ ...part, apart });
			}
		});
	}
	return parts;
}

function blockParts(block: Node, draw: ImageDrawer): Piece[] {
	if (block.type.name === "table") return [{ kind: "table", table: block }];
	const inPieces = block.type.name === "paragraph" || block.type.name === "heading";
	if (!inPieces || isEmptyTextblock(block)) return [{ kind: "text", blocks: [block] }];
	return piecesOfTextblock(block).map((piece): Piece => {
		if (piece.kind === "words") {
			return { kind: "text", blocks: [block.copy(Fragment.fromArray(piece.inline))] };
		}
		const alone = block.copy(Fragment.from(piece.image));
		const image = draw(piece.image.attrs.src);
		if (!image) return { kind: "text", blocks: [alone] };
		return {
			kind: "image",
			image,
			alone,
			words: wordsOf(piece.image),
			link: piece.image.attrs.link,
		};
	});
}

/** The words of an image, which a picture of it is described by, as the file can hold them (`xmlText`). */
const wordsOf = (image: Node) => xmlText(String(image.attrs.alt ?? ""));

/**
 * Stacks a box's parts in its content area, as tall together as the app sets
 * them and where its vertical alignment sits them, each as far from the one
 * before as the app sets it, turned with the box: text in boxes of its own,
 * with room to spare for Arial, tables with their rows as tall as the app's,
 * and images as large as the app draws them.
 */
function stack(
	slide: PptxGenJS.Slide,
	{
		frame,
		rotation,
		verticalAlign,
		area,
	}: Pick<BoxAttributes, "frame" | "rotation" | "verticalAlign"> & { area: Frame },
	parts: readonly Part[],
	setting: Setting,
	placing: Placing,
	measure: Measure,
) {
	const heights = parts.map((part) => heightOfPart(part, setting, placing, measure));
	const gaps = parts.map((part, index) => (index > 0 && part.apart ? setting.blockGap : 0));
	const total = [...heights, ...gaps].reduce((sum, each) => sum + each, 0);
	let y = area.y + alignedOffset(verticalAlign, area.height, total);
	parts.forEach((part, index) => {
		y += gaps[index] ?? 0;
		const height = heights[index] ?? 0;
		const slot = { x: area.x, y, w: area.width, h: height };
		const turned = (box: Box) => positionOf(turnedWith(box, frame, rotation));
		if (part.kind === "text") {
			if (!part.blocks.every(isEmptyTextblock)) {
				slide.addText(textOf(paragraphsIn(part.blocks, setting)), {
					...turned({ ...slot, h: grown(height) }),
					valign: "top",
					margin: 0,
					isTextBox: true,
				});
			}
		} else if (part.kind === "table") {
			const rows = tableRowHeights(part.table, rowHeightsOf(part.table, placing, measure), setting);
			// PowerPoint doesn't turn a table, so it is only moved to where the box's turn takes its middle.
			const { x, y: top } = turnedWith(slot, frame, rotation);
			slide.addTable(
				tableRowsOf(part.table, setting),
				tableOptions(part.table, { ...slot, x, y: top }, rows, setting),
			);
		} else {
			const shown = placedImage(part.image, slot);
			// PptxGenJS gives a picture of no width or height a size of its own, where the app draws nothing.
			if (shown.w > 0 && shown.h > 0) {
				slide.addImage({
					data: part.image.data,
					...pictureAt(part.image, shown, frame, rotation),
					altText: part.words,
					...pictureLinkTo(part.link),
				});
			}
		}
		y += height;
	});
}

/** How tall the app sets `part` in a box set as `placing` says, in points. */
function heightOfPart(part: Part, setting: Setting, placing: Placing, measure: Measure): number {
	switch (part.kind) {
		case "text":
			return heightOfBlocks(part.blocks, placing, measure);
		case "table":
			return tableRowHeights(
				part.table,
				rowHeightsOf(part.table, placing, measure),
				setting,
			).reduce((total, row) => total + row, 0);
		case "image":
			return heightOfBlocks([part.alone], placing, measure);
	}
}

/** Where `image` is shown upright in `slot`, at its top left: as large as it is, a pixel to a point, but no wider than the slot. */
function placedImage(image: DrawableImage, slot: Box): Box {
	const { width, height } = image.upright;
	const scale = Math.min(1, slot.w / width);
	return { x: slot.x, y: slot.y, w: width * scale, h: height * scale };
}

/** A freeform's points, as PptxGenJS takes them. */
type FreeformPoint = NonNullable<PptxGenJS.ShapeProps["points"]>[number];

interface Point {
	x: number;
	y: number;
}

/**
 * `path`, an SVG path in its box's own points, as PptxGenJS's points of a
 * freeform, in inches: its moves, lines, cubic and quadratic curves and
 * closes as PowerPoint's own, every point on the box. An arc is drawn as the
 * cubic curves that make it, as PowerPoint's own arcs can't be tilted. What
 * follows a close without a move starts where the closed figure did, as SVG
 * starts it, said as a move, as PowerPoint's own path says nothing of where a
 * close leaves it.
 */
function pointsOf(path: SvgPath): FreeformPoint[] {
	const points: FreeformPoint[] = [];
	const at = ({ x, y }: Point) => ({ x: inches(x), y: inches(y) });
	let current: Point = { x: 0, y: 0 };
	let start = current;
	let closed = false;
	/** The last curve's second control point, which a smooth curve after it mirrors, and its kind. */
	let control: { point: Point; cubic: boolean } | undefined;
	for (const command of pathCommandsOf(path)) {
		const moves = command.letter === "M" || command.letter === "m";
		if (closed && !moves) points.push({ ...at(start), moveTo: true });
		closed = command.letter === "Z" || command.letter === "z";
		const from = current;
		const relative = command.letter === command.letter.toLowerCase();
		const point = (x: number, y: number): Point =>
			relative ? { x: from.x + x, y: from.y + y } : { x, y };
		const before = control;
		const mirrored = (cubic: boolean): Point =>
			before && before.cubic === cubic
				? { x: 2 * from.x - before.point.x, y: 2 * from.y - before.point.y }
				: from;
		control = undefined;
		switch (command.letter) {
			case "M":
			case "m": {
				const [x, y] = command.values;
				current = start = point(x, y);
				points.push({ ...at(current), moveTo: true });
				break;
			}
			case "L":
			case "l": {
				const [x, y] = command.values;
				current = point(x, y);
				points.push(at(current));
				break;
			}
			case "H":
			case "h": {
				const [x] = command.values;
				current = { x: point(x, 0).x, y: from.y };
				points.push(at(current));
				break;
			}
			case "V":
			case "v": {
				const [y] = command.values;
				current = { x: from.x, y: point(0, y).y };
				points.push(at(current));
				break;
			}
			case "C":
			case "c": {
				const [x1, y1, x2, y2, x, y] = command.values;
				const second = point(x2, y2);
				current = point(x, y);
				points.push(cubicTo(point(x1, y1), second, current, at));
				control = { point: second, cubic: true };
				break;
			}
			case "S":
			case "s": {
				const [x2, y2, x, y] = command.values;
				const second = point(x2, y2);
				current = point(x, y);
				points.push(cubicTo(mirrored(true), second, current, at));
				control = { point: second, cubic: true };
				break;
			}
			case "Q":
			case "q":
			case "T":
			case "t": {
				const [near, end] =
					command.letter === "Q" || command.letter === "q"
						? [
								point(command.values[0], command.values[1]),
								point(command.values[2], command.values[3]),
							]
						: [mirrored(false), point(command.values[0], command.values[1])];
				current = end;
				const { x: x1, y: y1 } = at(near);
				points.push({ ...at(current), curve: { type: "quadratic", x1, y1 } });
				control = { point: near, cubic: false };
				break;
			}
			case "A":
			case "a": {
				const [rx, ry, tilt, large, clockwise, x, y] = command.values;
				current = point(x, y);
				for (const [first, second, end] of arcAsCubics(from, current, {
					rx,
					ry,
					tilt,
					large,
					clockwise,
				})) {
					points.push(cubicTo(first, second, end, at));
				}
				break;
			}
			case "Z":
			case "z":
				points.push({ close: true });
				current = start;
				break;
		}
	}
	return points;
}

function cubicTo(
	first: Point,
	second: Point,
	end: Point,
	at: (point: Point) => Point,
): FreeformPoint {
	const [{ x: x1, y: y1 }, { x: x2, y: y2 }] = [at(first), at(second)];
	return { ...at(end), curve: { type: "cubic", x1, y1, x2, y2 } };
}

/**
 * An SVG arc from `from` to `to` with its radii, its ellipse's tilt in
 * degrees and its two flags, for the larger arc and for drawing it clockwise,
 * as cubic curves of a quarter turn at most, each its two control points and
 * its end, as SVG's notes on implementing arcs work out its centre. An arc
 * with a radius of nothing is a line.
 */
function arcAsCubics(
	from: Point,
	to: Point,
	{
		rx: radiusX,
		ry: radiusY,
		tilt,
		large,
		clockwise: sweep,
	}: { rx: number; ry: number; tilt: number; large: 0 | 1; clockwise: 0 | 1 },
): [Point, Point, Point][] {
	if (from.x === to.x && from.y === to.y) return [];
	let rx = Math.abs(radiusX);
	let ry = Math.abs(radiusY);
	if (rx === 0 || ry === 0) return [[from, to, to]];
	const phi = (tilt * Math.PI) / 180;
	const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
	const halfX = (from.x - to.x) / 2;
	const halfY = (from.y - to.y) / 2;
	const x1 = cos * halfX + sin * halfY;
	const y1 = -sin * halfX + cos * halfY;
	const reach = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
	if (reach > 1) {
		rx *= Math.sqrt(reach);
		ry *= Math.sqrt(reach);
	}
	const across = rx * rx * y1 * y1 + ry * ry * x1 * x1;
	const share = Math.sqrt(Math.max(0, (rx * rx * ry * ry - across) / across));
	const sign = large === sweep ? -1 : 1;
	const centreX1 = sign * share * ((rx * y1) / ry);
	const centreY1 = sign * share * (-(ry * x1) / rx);
	const centre = {
		x: cos * centreX1 - sin * centreY1 + (from.x + to.x) / 2,
		y: sin * centreX1 + cos * centreY1 + (from.y + to.y) / 2,
	};
	const angle = (ux: number, uy: number, vx: number, vy: number) =>
		Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const startX = (x1 - centreX1) / rx;
	const startY = (y1 - centreY1) / ry;
	const first = angle(1, 0, startX, startY);
	let turn = angle(startX, startY, (-x1 - centreX1) / rx, (-y1 - centreY1) / ry);
	if (!sweep && turn > 0) turn -= 2 * Math.PI;
	if (sweep && turn < 0) turn += 2 * Math.PI;
	const pieces = Math.max(1, Math.ceil(Math.abs(turn) / (Math.PI / 2) - 1e-9));
	const step = turn / pieces;
	const handle = (4 / 3) * Math.tan(step / 4);
	const on = (t: number): Point => ({
		x: centre.x + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
		y: centre.y + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
	});
	const along = (t: number): Point => ({
		x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
		y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
	});
	return Array.from({ length: pieces }, (_, index): [Point, Point, Point] => {
		const [t1, t2] = [first + index * step, first + (index + 1) * step];
		const [p1, p2] = [on(t1), index === pieces - 1 ? to : on(t2)];
		const [d1, d2] = [along(t1), along(t2)];
		return [
			{ x: p1.x + handle * d1.x, y: p1.y + handle * d1.y },
			{ x: p2.x - handle * d2.x, y: p2.y - handle * d2.y },
			p2,
		];
	});
}

/**
 * The heights of a table's rows: as tall as the app sets them, `measured`,
 * but a line of their text tall at least, as a cell of PowerPoint's holds a
 * line even when it is empty, which the app's doesn't. A row past what is
 * measured, past a slide's height, is that line tall.
 */
function tableRowHeights(table: Node, measured: readonly number[], setting: Setting): number[] {
	const fontSize = TABLE_LOOK.text.size * setting.unit;
	const line = fontSize * TABLE_LOOK.text.lineHeight;
	return table.children.map((row, index) => {
		const height = measured[index] ?? 0;
		const header = row.firstChild?.type.name === "tableHeader";
		const inset = cellInsetOf(setting.look.tightCells, header, fontSize);
		return Math.max(height, 2 * inset.y + line + RULE_THICKNESS);
	});
}

/** A table as PowerPoint's own, filling `slot`, the columns of its grid (`tableGridOf`) as wide as each other, its rows `rowHeights` tall. */
function tableOptions(
	table: Node,
	slot: Box,
	rowHeights: readonly number[],
	setting: Setting,
): PptxGenJS.TableProps {
	const { columns } = tableGridOf(table);
	const { x, y, w } = inchesOf(slot);
	const h = rowHeights.reduce((total, row) => total + row, 0) / POINTS_PER_INCH;
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
 * A table's rows on its grid (`tableGridOf`), as the app draws them: the
 * header row's cells grey and bold on a tint, each row ruled below, each cell
 * padded as its box's look says (`cellInsetOf`) and across the columns it
 * spans, and a row of fewer cells than the grid has columns ending in empty
 * ones, which show nothing, as the app shows nothing where a row has no cell.
 */
function tableRowsOf(table: Node, setting: Setting): PptxGenJS.TableRow[] {
	const grid = tableGridOf(table);
	return grid.rows.map((cells) => {
		const last = cells.at(-1);
		const end = last ? last.column + last.span : 0;
		const missing = Array.from({ length: grid.columns - end }, () => NO_CELL);
		return [...cells.map((cell) => tableCellOf(cell, setting)), ...missing];
	});
}

function tableCellOf({ cell, column, span }: GridCell, setting: Setting): PptxGenJS.TableCell {
	const fontSize = TABLE_LOOK.text.size * setting.unit;
	const header = cell.type.name === "tableHeader";
	const weight = header
		? TABLE_LOOK.header.weight
		: column === 0
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
	};
	const inset = cellInsetOf(setting.look.tightCells, header, fontSize);
	return {
		text: textOf(paragraphsIn(cell.children, cellSetting)),
		options: {
			// In inches, as PptxGenJS reads a cell's margin of less than 1: top, right, bottom, left.
			margin: [inset.y, inset.x, inset.y, inset.x].map((points) => points / POINTS_PER_INCH) as [
				number,
				number,
				number,
				number,
			],
			border: [NO_BORDER, NO_BORDER, { type: "solid", pt: RULE_THICKNESS, color: RULE }, NO_BORDER],
			...(header ? { fill: { color: TINT } } : {}),
			...(span > 1 ? { colspan: span } : {}),
		},
	};
}

const NO_BORDER: PptxGenJS.BorderProps = { type: "none" };

/** Where a row has no cell: nothing, neither text nor rule. */
const NO_CELL: PptxGenJS.TableCell = {
	text: "",
	options: { border: [NO_BORDER, NO_BORDER, NO_BORDER, NO_BORDER] },
};

/*
 * Text: each block as the app sets it in the part of the slide its box is,
 * at the slide's step, its sizes, line heights and the space between its
 * blocks and its lists' items as the app's are, so it is as tall as the
 * app's; and as its own colour, size, font, alignment and line height say,
 * where it says them.
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

/** What is inherited down a box's blocks, as CSS inherits it. */
interface Setting {
	/** The look of the box the blocks are in (`boxLookOf`). */
	look: BoxLook;
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
}

/** What a box of `role` on a slide of `layout` sets its blocks with, at `step`. */
function settingIn(layout: SlideLayout, role: BoxRole | null, step: number): Setting {
	const look = boxLookOf(layout, role);
	const unit = step * SLIDE_UNIT;
	return {
		look,
		unit,
		fontSize: unit,
		blockGap: look.gap * unit,
		quoteLayout: layout === "quote",
		quoted: false,
	};
}

type Run = PptxGenJS.TextProps;
type RunOptions = PptxGenJS.TextPropsOptions;

/** A paragraph of PowerPoint's: its runs, its bullet or number and depth in a list, its alignment, line height and the space after it. */
interface Paragraph {
	runs: readonly Run[];
	bullet?: RunOptions["bullet"];
	level?: number;
	align: TextAlign;
	/** As the app's CSS gives it: a multiple of its size. */
	lineHeight: number;
	/** In points. */
	spaceAfter: number;
	/** Whether it is an empty paragraph's or heading's, which the app draws nothing tall (`isEmptyTextblock`). */
	empty?: boolean;
}

/** `blocks` as paragraphs, each block as far after the one before as `setting` sets them apart. */
const paragraphsIn = (blocks: readonly Node[], setting: Setting): Paragraph[] =>
	blocks.flatMap((block, index) => {
		const paragraphs = paragraphsOf(
			block,
			setting,
			index < blocks.length - 1 ? setting.blockGap : 0,
		);
		return isEmptyTextblock(block)
			? paragraphs.map((paragraph) => ({ ...paragraph, empty: true }))
			: paragraphs;
	});

/** The look of a paragraph's runs, which each takes unless its marks say otherwise. */
const runOptions = (style: TextStyle, setting: Setting): RunOptions => ({
	fontSize: style.size,
	color: style.color,
	...(style.bold ? { bold: true } : {}),
	...(setting.quoted ? { italic: true } : {}),
});

/** A paragraph of `style` holding `runs`, `after` points before the next, at the alignment and line height `block` sets, if it sets them. */
const paragraphWith = (
	runs: readonly Run[],
	style: TextStyle,
	setting: Setting,
	after: number,
	block?: Node,
): Paragraph => ({
	runs: runs.length > 0 ? runs : [{ text: "", options: runOptions(style, setting) }],
	align: (block && textAlignOf(block)) ?? "left",
	lineHeight: (block && lineHeightOf(block)) ?? style.lineHeight,
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
			return [paragraphWith(runs, style, setting, after, block)];
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
		return paragraphWith(
			runsOf(heading, runOptions(style, setting)),
			style,
			setting,
			after,
			heading,
		);
	}
	const style = { ...styleOf(look.heading, unit), color: TEXT };
	const rule = look.ruledHeadings ? COLUMN_LOOK.headingRuleGap * style.size + RULE_THICKNESS : 0;
	return paragraphWith(
		runsOf(heading, runOptions(style, setting)),
		style,
		setting,
		rule + after,
		heading,
	);
}

const isList = (block: Node) => ["bulletList", "orderedList"].includes(block.type.name);

/**
 * A list's items, as far apart as the part sets them, a list in an item a
 * little below it, each item aligned and spaced as its first block says.
 */
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
			.filter((child) => !isList(child) && !isEmptyTextblock(child))
			.flatMap((child) => paragraphsOf(child, itemSetting, 0).map(({ runs }) => runs));
		const nested = item.children.filter(isList);
		const first = item.firstChild ?? undefined;
		return [
			{
				...paragraphWith(
					joinedLines(lines, runOptions(style, itemSetting)),
					style,
					itemSetting,
					nested.length > 0 ? nestedGap : afterItem,
					first,
				),
				bullet: bulletOf(list, fontSize, level),
				level,
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

/**
 * A list's bullet, or its number from where it starts (`listStartOf`), within
 * the numbers PowerPoint starts a list at: one that starts at 0 or less
 * starts at 1, where the app counts from it.
 */
function bulletOf(list: Node, fontSize: number, level: number): RunOptions["bullet"] {
	const indent = fontSize * LIST_LOOK.indent;
	if (list.type.name === "orderedList") {
		return { type: "number", indent, numberStartAt: within(listStartOf(list), LIST_STARTS) };
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
	textStyle: (mark) => ownStyleOptions(ownTextStyleOf([mark])),
};

/** A run's own colour, size and font (see `slide-text-style.ts`), as PowerPoint sets a run's. */
function ownStyleOptions({ color, fontFamily, fontSize }: OwnTextStyle): RunOptions {
	const paint = paintOf(color ?? null);
	const typeface = fontFamily === undefined ? undefined : typefaceOf(fontFamily);
	return {
		...(paint ? { color: paint.color, transparency: transparencyOf(paint) } : {}),
		...(fontSize ? { fontSize } : {}),
		...(typeface ? { fontFace: typeface } : {}),
	};
}

/** CSS's generic families, as the fonts every copy of PowerPoint has that it draws for them. */
const GENERIC_TYPEFACES: Readonly<Record<string, string>> = {
	serif: "Times New Roman",
	"ui-serif": "Times New Roman",
	"sans-serif": FONT,
	"ui-sans-serif": FONT,
	"system-ui": FONT,
	monospace: CODE_FONT,
	"ui-monospace": CODE_FONT,
};

/**
 * The typeface PowerPoint draws text of `fontFamily`, a CSS font list, in:
 * the first family the list names, out of its quotes, or the font PowerPoint
 * has for a generic family, written as an attribute's value in the file's
 * XML, as PptxGenJS writes it as it is given.
 */
function typefaceOf(fontFamily: string): string | undefined {
	const [first = ""] = fontFamily.split(",");
	const name = first
		.trim()
		.replace(/^(["'])(.*)\1$/, "$2")
		.trim();
	if (name === "") return undefined;
	return escapeXml(GENERIC_TYPEFACES[name.toLowerCase()] ?? name);
}

/**
 * A link to `href`, when it goes somewhere a link in a file may (`linkInFile`).
 * A link keeps its text's colour and is underlined, as the app draws one.
 */
const linkTo = (href: unknown): { hyperlink?: PptxGenJS.HyperlinkProps } => {
	const url = linkInFile(href);
	return url ? { hyperlink: { url } } : {};
};

/** A link on a picture, as `linkTo`, its address written as an attribute's value in the file's XML, as PptxGenJS writes a picture's as it is given, though not a run's. */
const pictureLinkTo = (href: unknown): { hyperlink?: PptxGenJS.HyperlinkProps } => {
	const url = linkInFile(href);
	return url ? { hyperlink: { url: escapeXml(url) } } : {};
};

/**
 * Paragraphs as PptxGenJS's runs (`linesShown`): each paragraph's bullet,
 * depth, alignment, line spacing and the space before and after it on its
 * first run, which PowerPoint takes the paragraph's from, and a break after
 * its last; each run's text as the file can hold it (`xmlText`), at a size
 * PowerPoint holds.
 */
function textOf(paragraphs: readonly Paragraph[]): Run[] {
	return linesShown(paragraphs).flatMap(
		({ runs, bullet, level, align, lineHeight, spaceBefore, spaceAfter }) => {
			const [first = { text: "", options: {} }, ...rest] = runs.map(
				({ text, options }): Run & { options: RunOptions } => ({
					text: xmlText(text ?? ""),
					options: {
						...options,
						...(options?.fontSize ? { fontSize: within(options.fontSize, TEXT_SIZES) } : {}),
					},
				}),
			);
			const all = [
				{
					...first,
					options: {
						...first.options,
						bullet,
						align,
						...(level ? { indentLevel: level } : {}),
						lineSpacingMultiple: lineHeight / ARIAL_LINE_HEIGHT,
						...(spaceBefore > 0 ? { paraSpaceBefore: within(spaceBefore, PARAGRAPH_SPACES) } : {}),
						...(spaceAfter > 0 ? { paraSpaceAfter: within(spaceAfter, PARAGRAPH_SPACES) } : {}),
					},
				},
				...rest,
			];
			return all.map((run, index) =>
				index === all.length - 1 ? { ...run, options: { ...run.options, breakLine: true } } : run,
			);
		},
	);
}

/**
 * `paragraphs` without those of empty paragraphs and headings, which the app
 * draws nothing tall, where PowerPoint draws a line: the space either side of
 * each kept, after the paragraph before it, or before the first that is
 * kept. Text of nothing but those is kept as it is, as only a table's cell
 * may be, which PowerPoint gives a line anyway.
 */
function linesShown(paragraphs: readonly Paragraph[]): (Paragraph & { spaceBefore: number })[] {
	const shown: (Paragraph & { spaceBefore: number })[] = [];
	let before = 0;
	for (const paragraph of paragraphs) {
		const last = shown.at(-1);
		if (!paragraph.empty) {
			shown.push({ ...paragraph, spaceBefore: before });
			before = 0;
		} else if (last) {
			shown[shown.length - 1] = { ...last, spaceAfter: last.spaceAfter + paragraph.spaceAfter };
		} else {
			before += paragraph.spaceAfter;
		}
	}
	return shown.length > 0
		? shown
		: paragraphs.map((paragraph) => ({ ...paragraph, spaceBefore: 0 }));
}

/** The numbers PowerPoint starts a numbered list at. */
const LIST_STARTS = { least: 1, most: 32767 } as const;

/** The space PowerPoint keeps before or after a paragraph, in points. */
const PARAGRAPH_SPACES = { least: 0, most: 1584 } as const;

const within = (value: number, { least, most }: { least: number; most: number }) =>
	Math.min(most, Math.max(least, value));

/**
 * `file`, as PptxGenJS writes it, with what it writes otherwise than
 * PowerPoint does made as PowerPoint writes it: each slide's paragraphs with
 * their properties once and their end marks the size of their text, each
 * shape with an id of its own, an image without words given none, the empty
 * title PptxGenJS adds to each slide from its layout left out and the box
 * that is the slide's title made its title placeholder in its place, and a
 * section break's accent bar marked as decorative, which PptxGenJS has no
 * option for; each slide's notes as their paragraphs, which it writes as one
 * run; no layout but the deck's; and no entries for folders.
 */
async function withPowerPointsOwnForms(
	file: Awaited<ReturnType<PptxGenJS["write"]>>,
	slides: readonly DrawnSlide[],
): Promise<Uint8Array> {
	const zip = await JSZip.loadAsync(file);
	await Promise.all([
		...slides.map((slide, index) =>
			rewritten(zip, `ppt/slides/slide${index + 1}.xml`, (xml) => inOwnForms(xml, slide)),
		),
		...slides.map((slide, index) =>
			rewritten(zip, `ppt/notesSlides/notesSlide${index + 1}.xml`, (xml) =>
				withNotes(xml, slide.notes),
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

/** `xml`, a slide's, with its `accentBars` accent bars marked as decorative, inside the properties PptxGenJS writes empty for a shape without a link. */
const withAccentBarsDecorative = (xml: string, accentBars: number) =>
	replacedExactly(
		xml,
		new RegExp(`(<p:cNvPr id="\\d+" name="${ACCENT_BAR_NAME}">)(</p:cNvPr>)`, "g"),
		accentBars,
		(_properties, start: string, end: string) => `${start}${DECORATIVE_MARK}${end}`,
	);

/**
 * `xml` with each of the `count` matches of `pattern`, a global one, changed
 * by `change`. These are changes the file needs, so a version of PptxGenJS
 * that writes what they change otherwise, and so matches more or fewer times,
 * is an error, never a file made without them.
 */
function replacedExactly(
	xml: string,
	pattern: RegExp,
	count: number,
	change: (match: string, ...groups: string[]) => string,
): string {
	const found = xml.match(pattern)?.length ?? 0;
	if (found !== count) {
		throw new Error(`PptxGenJS wrote ${found} of ${pattern}, not the ${count} expected`);
	}
	return xml.replace(pattern, change);
}

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

/*
 * A slide of PptxGenJS's holds no shape in another, so a shape is from its
 * start to the first end after it, and a shape holding something is one
 * holding it before that end.
 */

/** `xml`, a slide's, without the empty placeholder PptxGenJS adds to each slide for its layout's title, as the slide is given nothing for it. */
const withoutLayoutPlaceholder = (xml: string) =>
	replacedExactly(xml, /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph[\s\S]*?<\/p:sp>/g, 1, () => "");

/**
 * `xml` with the box named `TITLE_NAME` the slide's title placeholder, whose
 * look and place it says itself: a shape rather than a text box, marked as
 * the title, and each of its runs that isn't bold saying so, as a run of a
 * title placeholder takes the layout's title's look for what it doesn't say,
 * and the layout's title is bold.
 */
const withTitlePlaceholder = (xml: string) =>
	replacedExactly(
		xml,
		new RegExp(`<p:sp>(?:(?!</p:sp>)[\\s\\S])*?name="${TITLE_NAME}"[\\s\\S]*?</p:sp>`, "g"),
		1,
		(shape) =>
			replacedExactly(
				shape.replace('<p:cNvSpPr txBox="1"/>', "<p:cNvSpPr/>"),
				/<p:nvPr><\/p:nvPr>/g,
				1,
				() => '<p:nvPr><p:ph type="title"/></p:nvPr>',
			).replace(/<a:rPr\b(?![^>]*\bb=")/g, '<a:rPr b="0"'),
	);

/** `xml` with its shapes numbered in order: PptxGenJS numbers a table as it may number another shape. */
function withShapeIdsOfTheirOwn(xml: string): string {
	let id = 0;
	return xml.replace(/(<p:cNvPr id=")\d+"/g, (_id, start: string) => {
		id += 1;
		return `${start}${id}"`;
	});
}

/** `xml`, `slide`'s as PptxGenJS writes it, in the file's own forms. */
function inOwnForms(xml: string, slide: DrawnSlide): string {
	const forms: ((xml: string) => string)[] = [
		(within) => within.replaceAll(MADE_UP_IMAGE_WORDS, ""),
		(within) => withAccentBarsDecorative(within, slide.accentBars),
		withParagraphPropertiesOnce,
		withEndMarksSizedAsTheirText,
		withoutLayoutPlaceholder,
		...(slide.titled ? [withTitlePlaceholder] : []),
		withShapeIdsOfTheirOwn,
	];
	return forms.reduce((within, change) => change(within), xml);
}

/** The body of a notes slide, which PptxGenJS writes holding the notes as one run. */
const NOTES_BODY = /(<p:ph type="body" idx="1"\/>[\s\S]*?)<p:txBody>[\s\S]*?<\/p:txBody>/g;

const withNotes = (xml: string, notes: readonly Node[]) =>
	replacedExactly(
		xml,
		NOTES_BODY,
		1,
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

/** `zip` without PptxGenJS's blank layout, so PowerPoint's Layout menu lists the deck's alone. */
async function withoutDefaultLayout(zip: JSZip) {
	const masterRelationships = "ppt/slideMasters/_rels/slideMaster1.xml.rels";
	const relationships = await zip.file(masterRelationships)?.async("string");
	const relationship = new RegExp(
		`<Relationship Id="(rId\\d+)"[^>]*Target="\\.\\./slideLayouts/${DEFAULT_LAYOUT}"/>`,
	).exec(relationships ?? "");
	if (!relationship) throw new Error(`PptxGenJS wrote no ${DEFAULT_LAYOUT} for its master`);
	const [written, id] = relationship;
	const removed = (pattern: RegExp) => (xml: string) => replacedExactly(xml, pattern, 1, () => "");
	await Promise.all([
		rewritten(zip, masterRelationships, (xml) => xml.replace(written, "")),
		rewritten(zip, MASTER, removed(new RegExp(`<p:sldLayoutId id="\\d+" r:id="${id}"/>`, "g"))),
		rewritten(
			zip,
			"[Content_Types].xml",
			removed(new RegExp(`<Override PartName="/ppt/slideLayouts/${DEFAULT_LAYOUT}"[^>]*/>`, "g")),
		),
	]);
	zip.remove(`ppt/slideLayouts/${DEFAULT_LAYOUT}`);
	zip.remove(`ppt/slideLayouts/_rels/${DEFAULT_LAYOUT}.rels`);
}

/** `text` as XML's text or an attribute's value: what XML can hold of it (`xmlText`), its markup escaped. */
const escapeXml = (text: string) =>
	xmlText(text).replace(/[&<>"]/g, (character) => XML_ENTITIES[character] ?? character);

/**
 * `text` without the characters XML can't hold: control characters but tab,
 * line feed and carriage return, a surrogate on its own, and the two
 * noncharacters at the end of the first plane. A deck's text may hold any,
 * and PptxGenJS writes them as they are, making a file no program opens.
 */
const xmlText = (text: string) => [...text].filter(isXmlCharacter).join("");

function isXmlCharacter(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return (
		code === TAB ||
		code === LINE_FEED ||
		code === CARRIAGE_RETURN ||
		(code >= SPACE && code < FIRST_SURROGATE) ||
		(code > LAST_SURROGATE && code < FIRST_PLANE_END) ||
		code > LAST_OF_FIRST_PLANE
	);
}

const TAB = 0x9;
const LINE_FEED = 0xa;
const CARRIAGE_RETURN = 0xd;
const SPACE = 0x20;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;
/** The first of the two noncharacters ending the first plane. */
const FIRST_PLANE_END = 0xfffe;
const LAST_OF_FIRST_PLANE = 0xffff;

const XML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};
