import type { Artifact, ArtifactImageType } from "@sugabots/contracts";
import type { ArtifactImageIds } from "@sugabots/contracts/http";
import { backgroundOf } from "@sugabots/contracts/live-slides";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "@sugabots/contracts/slide-geometry";
import type { Node } from "@tiptap/pm/model";
import { Clock, Effect } from "effect";
import { imageSize } from "image-size";
import PDFDocument from "pdfkit";
import { piecesIn, type Typesetter, typesetterOn, widthOfSpaces } from "./pdf-fonts.ts";
import { BACKGROUND, type DeckImage, ownImagesIn, paintOf } from "./slide-design.ts";
import { arrangedSlide, type Box, type Measure, type Pen, type Size } from "./slide-layout.ts";

/** The media type of a PDF. */
export const PDF_CONTENT_TYPE = "application/pdf";

/**
 * `deck`, a `slides` deck as people see it, as a PDF titled as the artifact
 * is: a page for each of the deck's slides, in order, that is the slide, 16:9
 * and edge to edge, on its background, or white. Each box is drawn at its
 * frame, in the order the slide holds them, turned as it is turned: its fill,
 * its outline and its shape's path, then what it holds, within its padding and
 * where its vertical alignment sits it (`slide-layout.ts`). Its text is real
 * text in the app's fonts, which the file holds as much of as it draws
 * (`pdf-fonts.ts`), whatever font a stretch of it names; text in its own
 * colour and size keeps them, and text that says none is drawn as the app
 * draws text of its box's role (`slide-design.ts`), at the largest of the
 * app's steps at which the slide fits. What runs past the slide's edges is
 * cut off there. A link to an absolute address can be followed. An image the
 * deck keeps is drawn upright, as its EXIF orientation says, filling its box
 * when it is alone in a box of the image role (`imageFitOf`), when it is a PNG
 * or a JPEG PDFKit can read and hold, within the pixels a deck may have
 * unpacked to draw it (`drawnImagesIn`); any other image is its words in a
 * dashed box, as the app shows an image it doesn't load. Speaker notes are
 * left out.
 *
 * A character no font holds is drawn as the font's mark for a missing
 * character, marked with the character it stands for, which a reader that
 * reads such marks copies.
 *
 * `imageOf` is asked only for images of the kinds a PDF draws, and answers
 * `undefined` for one of another kind without reading it.
 */
export const pdfFileOf = <E, R>(
	artifact: Pick<Artifact, "podId" | "id" | "title">,
	deck: Node,
	imageOf: (
		image: ArtifactImageIds,
		kinds: ReadonlySet<ArtifactImageType>,
	) => Effect.Effect<DeckImage | undefined, E, R>,
): Effect.Effect<Uint8Array, E, R> =>
	Effect.gen(function* () {
		const own = ownImagesIn(deck, { podId: artifact.podId, artifactId: artifact.id });
		const found = yield* Effect.forEach(own, ([address, ids]) =>
			Effect.map(imageOf(ids, DRAWN_TYPES), (image) => [address, image] as const),
		);
		const kept = new Map(
			found.flatMap(([address, image]) => (image ? [[address, image] as const] : [])),
		);
		const createdAt = new Date(yield* Clock.currentTimeMillis);
		return yield* Effect.promise(() => pdfOf(artifact.title, deck, kept, createdAt));
	});

/** The kinds of image a PDF holds as they are. */
const DRAWN_TYPES: ReadonlySet<ArtifactImageType> = new Set(["image/png", "image/jpeg"]);

/**
 * A page the size of a 16:9 slide as slides apps save one: 10 inches by
 * 5.625, in points. A slide is laid out 960 wide and drawn scaled to it.
 */
const PAGE = { width: 720, height: 405 };

async function pdfOf(
	title: string,
	deck: Node,
	images: ReadonlyMap<string, DeckImage>,
	createdAt: Date,
): Promise<Uint8Array> {
	const document = new PDFDocument({
		size: [PAGE.width, PAGE.height],
		margin: 0,
		autoFirstPage: false,
		pdfVersion: "1.4",
		displayTitle: true,
		info: { Title: title, CreationDate: createdAt },
	});
	const written = writtenOut(document);
	const typesetter = typesetterOn(document);
	const drawn = drawnImagesIn(document, images);
	const measure: Measure = { widthOf: typesetter.widthOf, imageSizeAt: drawn.sizeAt };
	const pen = penOn(document, typesetter, drawn);
	for (const slide of deck.children) {
		document.addPage({ size: [PAGE.width, PAGE.height], margin: 0 });
		document.scale(PAGE.width / SLIDE_WIDTH);
		pen.fill({ x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, { color: BACKGROUND });
		const background = paintOf(backgroundOf(slide));
		if (background) {
			pen.fill({ x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, background);
		}
		arrangedSlide(slide, measure).draw(pen);
	}
	document.end();
	return written;
}

/** Everything `document` writes, once it has ended. */
function writtenOut(document: PDFKit.PDFDocument): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	document.on("data", (chunk: Buffer) => chunks.push(chunk));
	return new Promise((resolve, reject) => {
		document.on("end", () => resolve(Buffer.concat(chunks)));
		document.on("error", reject);
	});
}

const hex = (color: string) => `#${color}`;

/*
 * Images. PDFKit copies a JPEG's data into the file as it is, but may unpack
 * every pixel of a PNG to draw it, at once and holding the server while it
 * does: a PNG with transparency of its own, as a screenshot often has, is
 * unpacked whole, its transparency split from its colours, and both packed
 * again. Unpacking one here took 28 milliseconds and 11.5 MB at peak for each
 * million pixels, so the pixels a PNG may have, and a deck's PNGs may have in
 * all, are bounded, by its header, before PDFKit reads more of it.
 */

/**
 * The most pixels a PNG may have to be drawn: 0.7 seconds and 290 MB to
 * unpack, as measured, with room for a screenshot of a 6K screen (20 million
 * pixels) or a 24-megapixel camera's photo.
 */
const MOST_PNG_PIXELS = 25_000_000;

/**
 * The most pixels a deck's PNGs may have in all to be drawn, the first ones
 * its slides reach first: 5.6 seconds to unpack, as measured, and room for
 * twenty-four screenshots of a 4K screen.
 */
const MOST_PNG_PIXELS_IN_A_DECK = 200_000_000;

/** The most pixels any image may have to be drawn: more than any camera's photo, which only a damaged or made-up header says. */
const MOST_PIXELS = 200_000_000;

/** An image PDFKit has read, which it holds once however often it is drawn. */
interface OpenedImage {
	width: number;
	height: number;
	/** Its EXIF orientation: from 5 on, it is drawn on its side, its width and height swapped. */
	orientation?: number;
	/** Puts it in `document`, unpacking it if it must. */
	embed(document: PDFKit.PDFDocument): void;
	/** The object it is put in, once it is; `offset` is where in the file once the object is written. */
	obj?: { offset?: number; end(): void };
}

/** PDFKit's reading of an image ahead of drawing it, which its typings leave out. */
interface ImageReading {
	openImage(source: Buffer): OpenedImage;
	image(image: OpenedImage, x: number, y: number, size: { width: number; height: number }): unknown;
}

/** The images a deck keeps as a PDF draws them. */
interface DrawnImages {
	/** The image at `address`, in the document and ready to draw: `undefined` for one that is drawn as its words. */
	at(address: string): OpenedImage | undefined;
	/** Its size as it is drawn, upright. */
	sizeAt(address: string): Size | undefined;
}

/**
 * The images the deck keeps that `document` draws. Whether one is drawn is
 * decided once, the first time a slide's layout reaches it: when it is of a
 * kind a PDF holds, its header gives a size that is neither empty nor past
 * the pixels it may have, the deck's PNGs have room for its pixels still,
 * and PDFKit reads it and puts it in the document. Anything else about it,
 * from damaged data to a header that lies, leaves it to be drawn as its words.
 */
function drawnImagesIn(
	document: PDFKit.PDFDocument,
	images: ReadonlyMap<string, DeckImage>,
): DrawnImages {
	const decided = new Map<string, OpenedImage | undefined>();
	let pngPixelsLeft = MOST_PNG_PIXELS_IN_A_DECK;

	const drawable = (image: DeckImage | undefined): OpenedImage | undefined => {
		if (!image || !DRAWN_TYPES.has(image.contentType)) return undefined;
		const pixels = pixelsInHeader(image.bytes);
		if (pixels === undefined || pixels > MOST_PIXELS) return undefined;
		if (image.contentType === "image/png") {
			if (pixels > MOST_PNG_PIXELS || pixels > pngPixelsLeft) return undefined;
			pngPixelsLeft -= pixels;
		}
		return embeddedIn(document, image.bytes);
	};

	const at = (address: string) => {
		if (!decided.has(address)) decided.set(address, drawable(images.get(address)));
		return decided.get(address);
	};
	return {
		at,
		sizeAt(address) {
			const image = at(address);
			if (!image) return undefined;
			const sideways = (image.orientation ?? 1) > 4;
			return sideways
				? { width: image.height, height: image.width }
				: { width: image.width, height: image.height };
		},
	};
}

/** How many pixels an image's header says it has: `undefined` when it can't be read, or says none. */
function pixelsInHeader(bytes: Uint8Array): number | undefined {
	try {
		const { width = 0, height = 0 } = imageSize(bytes);
		return width >= 1 && height >= 1 ? width * height : undefined;
	} catch {
		return undefined;
	}
}

/** The image `bytes` hold, read by PDFKit and put in `document`: `undefined` when PDFKit can't do either. */
function embeddedIn(document: PDFKit.PDFDocument, bytes: Uint8Array): OpenedImage | undefined {
	let image: OpenedImage | undefined;
	try {
		image = (document as unknown as ImageReading).openImage(Buffer.from(bytes));
		if (!(image.width >= 1 && image.height >= 1)) return undefined;
		image.embed(document);
		return image;
	} catch {
		// One that fails partway leaves its object unwritten, which the document waits for before it ends.
		if (image?.obj && image.obj.offset === undefined) image.obj.end();
		return undefined;
	}
}

function penOn(document: PDFKit.PDFDocument, typesetter: Typesetter, images: DrawnImages): Pen {
	const reading = document as unknown as ImageReading;
	/** The boxes drawing is cut off at, outermost first, down the slide. */
	const clips: Box[] = [];
	/** How many turns what is drawn is within, which take it off the slide's own lines. */
	let turns = 0;
	return {
		text(type, text, x, baseline) {
			let at = x;
			for (const piece of piecesIn(type.face, text)) {
				if (piece.kind === "space") {
					at += widthOfSpaces(type, piece);
					continue;
				}
				const drawn = typesetter.set(type.face, type.size, piece);
				if (!drawn) continue;
				// A character no font holds is drawn as missing, so what it says is given for copying and searching.
				if (piece.kind === "missing") document.markContent("Span", { actual: piece.text });
				document.fillColor(hex(type.color), type.opacity ?? 1).text(drawn, at, baseline, {
					lineBreak: false,
					baseline: "alphabetic",
					features: type.features,
					...(type.tracking ? { characterSpacing: type.tracking } : {}),
				});
				if (piece.kind === "missing") document.endMarkedContent();
				at += typesetter.setWidthOf(type, drawn);
			}
		},
		fill({ x, y, width, height }, { color, opacity = 1, radius = 0 }) {
			document.save();
			document.fillColor(hex(color), opacity);
			(radius > 0
				? document.roundedRect(x, y, width, height, radius)
				: document.rect(x, y, width, height)
			).fill();
			document.restore();
		},
		dashed({ x, y, width, height }, { color, radius }) {
			document.save();
			document
				.lineWidth(1)
				.dash(3, { space: 2 })
				.roundedRect(x + 0.5, y + 0.5, width - 1, height - 1, radius)
				.stroke(hex(color));
			document.restore();
		},
		shape({ x, y, width, height }, { path, fill, stroke }) {
			document.save();
			document.translate(x, y);
			if (fill) {
				document.fillColor(hex(fill.color), fill.opacity);
				(path ? document.path(path) : document.rect(0, 0, width, height)).fill();
			}
			if (stroke) {
				// The app draws a box's outline within its frame, and a shape's on its path.
				const inset = path ? 0 : stroke.width / 2;
				const outline = path
					? document.path(path)
					: document.rect(
							inset,
							inset,
							Math.max(0, width - stroke.width),
							Math.max(0, height - stroke.width),
						);
				outline
					.lineWidth(stroke.width)
					.strokeColor(hex(stroke.paint.color), stroke.paint.opacity)
					.stroke();
			}
			document.restore();
		},
		// PDFKit turns and mirrors an image upright as its EXIF orientation says, as a browser does.
		image(address, { x, y, width, height }, clip, radius) {
			const image = images.at(address);
			if (!image) return;
			document.save();
			document.roundedRect(clip.x, clip.y, clip.width, clip.height, radius).clip();
			reading.image(image, x, y, { width, height });
			document.restore();
		},
		rotated({ x, y, width, height }, degrees, draw) {
			if (degrees === 0) return draw();
			document.save();
			document.rotate(degrees, { origin: [x + width / 2, y + height / 2] });
			turns += 1;
			draw();
			turns -= 1;
			document.restore();
		},
		clipped(box, draw) {
			const { x, y, width, height } = box;
			document.save();
			document.rect(x, y, width, height).clip();
			if (turns === 0) clips.push(box);
			draw();
			if (turns === 0) clips.pop();
			document.restore();
		},
		cutsOffFrom: (y) => turns === 0 && clips.some((clip) => y >= clip.y + clip.height),
		// A link reaches only as far down as what it is drawn with shows.
		link({ x, y, width, height }, url) {
			const bottom =
				turns === 0
					? clips.reduce((lowest, clip) => Math.min(lowest, clip.y + clip.height), y + height)
					: y + height;
			if (bottom > y) document.link(x, y, width, bottom - y, url);
		},
	};
}
