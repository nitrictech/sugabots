import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { create, type Font } from "fontkit";

/*
 * The faces a deck's PDF draws its text in, which are the app's: Rubik, and
 * JetBrains Mono for code. Each comes from the static fonts of its Fontsource
 * package, which a browser is served too: a file for each weight and style,
 * split by script. A face here is the files of one weight and style for the
 * scripts drawn left to right, and each character is drawn with the first of
 * them that holds it, as a browser picks the file for a character by the
 * range of characters each says it holds. Rubik's Hebrew and Arabic files
 * are left out, as text here is set left to right only.
 *
 * A character neither face holds is drawn, as a browser falls back to
 * another font, with the first of three Noto faces that holds it: Noto Sans
 * for Greek, Noto Sans Math for arrows, mathematical signs and shapes, and
 * Noto Sans Symbols 2 for ticks, crosses and other symbols. One none of them
 * holds, such as an emoji or a character of another script, is drawn as the
 * face's mark for a missing character. A space none holds is as wide as
 * Unicode says it is, and a character that shows nothing, such as a joiner,
 * a direction mark or a soft hyphen, draws nothing and takes no room.
 *
 * The files are found where Node finds the packages, from this module, so a
 * built server finds them in the dependencies it is installed with. Each is
 * read once, the first time a deck needs it, and the font read from it is
 * kept for the life of the process and drawn with by every document, which
 * would otherwise read the file again for itself.
 *
 * Text in them is set and measured on a PDFKit document (`typesetterOn`):
 * the PDF's own, which draws it, or one the PowerPoint file only measures its
 * text with, so both measure text alike.
 */

/** Text, or code. */
export type FontFamily = "sans" | "mono";

/** A family at a weight, upright or italic. */
export interface Face {
	family: FontFamily;
	/** As CSS weighs it, from 100 to 900. */
	weight: number;
	italic: boolean;
}

/** One file of a face: what a document registers it under, and the font read from it. */
export interface FaceFile {
	name: string;
	font: Font;
}

interface FamilyFiles {
	/** The package, and the start of each file's name in its `files` folder. */
	source: { package: string; prefix: string };
	/** The lightest and heaviest weight it comes in, a file for each hundred between. */
	weights: { lightest: number; heaviest: number };
	/** Whether it comes in italic: a family that doesn't draws italic text upright. */
	italics: boolean;
	/** The scripts and sets of symbols it is split by, as its files name them, most used first. */
	subsets: readonly string[];
}

const FAMILIES: Readonly<Record<FontFamily, FamilyFiles>> = {
	sans: {
		source: { package: "@fontsource/rubik", prefix: "rubik" },
		weights: { lightest: 300, heaviest: 900 },
		italics: true,
		subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext"],
	},
	mono: {
		source: { package: "@fontsource/jetbrains-mono", prefix: "jetbrains-mono" },
		weights: { lightest: 100, heaviest: 800 },
		italics: true,
		subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "vietnamese"],
	},
};

/** The families a character the text's own face lacks is looked for in, in order. */
const FALLBACKS: readonly FamilyFiles[] = [
	{
		source: { package: "@fontsource/noto-sans", prefix: "noto-sans" },
		weights: { lightest: 100, heaviest: 900 },
		italics: true,
		subsets: ["latin", "latin-ext", "greek", "greek-ext", "vietnamese"],
	},
	{
		source: { package: "@fontsource/noto-sans-math", prefix: "noto-sans-math" },
		weights: { lightest: 400, heaviest: 400 },
		italics: false,
		subsets: ["latin"],
	},
	{
		source: { package: "@fontsource/noto-sans-symbols-2", prefix: "noto-sans-symbols-2" },
		weights: { lightest: 400, heaviest: 400 },
		italics: false,
		subsets: ["symbols", "math"],
	},
];

const resolve = createRequire(import.meta.url).resolve;

const filesOfFaces = new Map<string, readonly FaceFile[]>();

/**
 * The files of `face`, most used script first, at the weight nearest the one
 * asked for that the family comes in. The first, the Latin alphabet's, also
 * draws the mark of a character none of them holds.
 */
export function filesOf(face: Face): readonly [FaceFile, ...FaceFile[]] {
	const files = familyFilesOf(FAMILIES[face.family], face);
	const [first, ...rest] = files;
	if (!first) throw new Error(`${FAMILIES[face.family].source.package} names no scripts`);
	return [first, ...rest];
}

/** The files of `family` at `face`'s weight and style, or the nearest it comes in. */
function familyFilesOf(
	{ source, weights, italics, subsets }: FamilyFiles,
	face: Face,
): readonly FaceFile[] {
	const weight = Math.min(
		weights.heaviest,
		Math.max(weights.lightest, nearestHundred(face.weight)),
	);
	const style = face.italic && italics ? "italic" : "normal";
	const key = `${source.prefix}-${weight}-${style}`;
	let files = filesOfFaces.get(key);
	if (!files) {
		files = subsets.map((subset) => {
			const name = `${source.prefix}-${subset}-${weight}-${style}`;
			const bytes = readFileSync(resolve(`${source.package}/files/${name}.woff`));
			return { name, font: fontIn(name, bytes) };
		});
		filesOfFaces.set(key, files);
	}
	return files;
}

const nearestHundred = (weight: number) => Math.round(weight / 100) * 100;

function fontIn(name: string, bytes: Buffer): Font {
	const font = create(bytes);
	if (!("hasGlyphForCodePoint" in font)) throw new Error(`${name} is a collection of fonts`);
	return font;
}

/** A piece of text as it is drawn. */
export type FacePiece =
	/** Drawn with one file of the face, or of a face it falls back to. */
	| { kind: "glyphs"; text: string; file: FaceFile }
	/** Held by no file: drawn as the face's mark for a missing character, with the characters that join or vary it. */
	| { kind: "missing"; text: string }
	/** Spaces no file holds, drawn as room `ems` wide each. */
	| { kind: "space"; text: string; ems: number };

/**
 * `text` split into the pieces the files of `face` and of the faces it falls
 * back to draw, in order. A character stays with the face's file before it
 * when that holds it too, so a line of one script is one piece; a character
 * the face lacks is drawn by the first fallback that holds it, and the face
 * is tried again for the next. A character that shows nothing is left out,
 * and so ends the piece before it, as it keeps the characters either side of
 * it from being drawn as one.
 */
export function piecesIn(face: Face, text: string): FacePiece[] {
	const own = filesOf(face);
	const pieces: FacePiece[] = [];
	let afterNothing = false;
	for (const character of text.normalize("NFC")) {
		const codePoint = character.codePointAt(0) ?? 0;
		const last = pieces.at(-1);
		if (last?.kind === "missing" && isJoiner(codePoint)) {
			last.text += character;
			continue;
		}
		if (SHOWS_NOTHING.test(character)) {
			afterNothing = true;
			continue;
		}
		const piece = pieceOf(face, own, codePoint, afterNothing ? undefined : last);
		afterNothing = false;
		if (piece !== last) pieces.push(piece);
		piece.text += character;
	}
	return pieces;
}

/** The piece the character `codePoint` is drawn in: `last`, when it goes on in that, or a new, empty one. */
function pieceOf(
	face: Face,
	own: readonly FaceFile[],
	codePoint: number,
	last: FacePiece | undefined,
): FacePiece {
	const holds = (file: FaceFile) => file.font.hasGlyphForCodePoint(codePoint);
	if (last?.kind === "glyphs" && own.includes(last.file) && holds(last.file)) return last;
	const ownFile = own.find(holds);
	if (ownFile) return last?.kind === "glyphs" && last.file === ownFile ? last : glyphs(ownFile);
	const ems = SPACE_EMS.get(codePoint);
	if (ems !== undefined) {
		return last?.kind === "space" && last.ems === ems ? last : { kind: "space", text: "", ems };
	}
	if (EMOJI.test(String.fromCodePoint(codePoint))) {
		return last?.kind === "missing" ? last : { kind: "missing", text: "" };
	}
	for (const family of FALLBACKS) {
		const fallback = familyFilesOf(family, face).find(holds);
		if (fallback)
			return last?.kind === "glyphs" && last.file === fallback ? last : glyphs(fallback);
	}
	return last?.kind === "missing" ? last : { kind: "missing", text: "" };
}

const glyphs = (file: FaceFile): FacePiece => ({ kind: "glyphs", text: "", file });

/**
 * Characters drawn as emoji, in colour, wherever a browser draws them. A
 * fallback face holds a few of them in black and white only, and none of
 * what joins or varies them, so they are drawn as missing, together with it.
 */
const EMOJI = /\p{Emoji_Presentation}/u;

/**
 * Characters that show nothing, which draw nothing and take no room: joiners,
 * direction marks and the soft hyphen among them, as Unicode lists those a
 * font that lacks them leaves out. Where a line may break at a soft hyphen or
 * a zero-width space is the layout's to say.
 */
const SHOWS_NOTHING = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Spaces a face may lack, by how wide Unicode says each is, in ems: the en
 * and em quads and spaces, the three-, four- and six-per-em spaces, the thin
 * space, the narrow no-break space, which is as wide as a thin one, the
 * medium mathematical space, and the ideographic space.
 */
const SPACE_EMS: ReadonlyMap<number, number> = new Map([
	[0x2000, 1 / 2],
	[0x2001, 1],
	[0x2002, 1 / 2],
	[0x2003, 1],
	[0x2004, 1 / 3],
	[0x2005, 1 / 4],
	[0x2006, 1 / 6],
	[0x2009, 1 / 5],
	[0x202f, 1 / 5],
	[0x205f, 4 / 18],
	[0x3000, 1],
]);

/** How a stretch of text is set in a face. */
export interface TextType {
	face: Face;
	/** In points. */
	size: number;
	/** The space after each character, in points. */
	tracking: number;
	/** OpenType features to draw it with besides the font's own, such as figures all as wide as each other. */
	features?: PDFKit.Mixins.OpenTypeFeatures[];
}

/** A piece drawn with a font: its glyphs, or the mark for its missing characters. */
export type DrawnPiece = Exclude<FacePiece, { kind: "space" }>;

/** Text set on a PDFKit document in the app's fonts, and measured as the document draws it. */
export interface Typesetter {
	/** Sets the document to draw `piece` of `face`'s text at `size`, and gives what of it is drawn. */
	set(face: Face, size: number, piece: DrawnPiece): string;
	/** The width of `drawn`, as the document is set to draw it, letter spacing and all. */
	setWidthOf(type: TextType, drawn: string): number;
	/** The width of `text` set as `type`, each piece in the file that holds it. */
	widthOf(type: TextType, text: string): number;
}

/** Sets text on `document`, registering each file of a face with it the first time a piece of text needs it. */
export function typesetterOn(document: PDFKit.PDFDocument): Typesetter {
	const registered = new Set<string>();
	const widths = new Map<string, number>();

	const set = (face: Face, size: number, piece: DrawnPiece) => {
		const file = piece.kind === "glyphs" ? piece.file : filesOf(face)[0];
		if (!registered.has(file.name)) {
			document.registerFont(file.name, file.font);
			registered.add(file.name);
		}
		document.font(file.name).fontSize(size);
		return piece.kind === "glyphs" ? piece.text : withoutJoiners(piece.text);
	};

	const setWidthOf = (type: TextType, drawn: string) =>
		document.widthOfString(drawn, { features: type.features }) + type.tracking * [...drawn].length;

	return {
		set,
		setWidthOf,
		widthOf(type, text) {
			const { face, size, tracking, features = [] } = type;
			const key = `${face.family}|${face.weight}|${face.italic}|${size}|${tracking}|${features}|${text}`;
			const known = widths.get(key);
			if (known !== undefined) return known;
			let width = 0;
			for (const piece of piecesIn(face, text)) {
				width +=
					piece.kind === "space"
						? widthOfSpaces(type, piece)
						: setWidthOf(type, set(face, size, piece));
			}
			widths.set(key, width);
			return width;
		},
	};
}

declare global {
	namespace PDFKit.Mixins {
		interface PDFFont {
			/**
			 * Registers a font fontkit has already read, which PDFKit draws with as
			 * it is, though its types list only a font's file or bytes.
			 */
			registerFont(name: string, src: Font): this;
		}
	}
}

/** The room `piece`'s spaces take set as `type`, letter spacing and all. */
export function widthOfSpaces(type: TextType, piece: FacePiece & { kind: "space" }): number {
	const count = [...piece.text].length;
	return count * (piece.ems * type.size + type.tracking);
}

/** Characters that join others or choose how they look, such as an emoji's, and show nothing themselves. */
const isJoiner = (codePoint: number) =>
	codePoint === 0x200d ||
	(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
	(codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
	(codePoint >= 0xe0020 && codePoint <= 0xe007f);

/** `text` without the characters that show nothing themselves, which a font without them would draw as missing. */
export const withoutJoiners = (text: string) =>
	[...text].filter((character) => !isJoiner(character.codePointAt(0) ?? 0)).join("");

/** A family's measures as multiples of its size, which are the same in every weight. */
export interface FamilyMetrics {
	/** How far its text reaches above the baseline and below. */
	ascent: number;
	descent: number;
	/** How far below the baseline an underline is, and how thick. */
	underlinePosition: number;
	underlineThickness: number;
	/** How far above the baseline a line through text is, and how thick. */
	strikeoutPosition: number;
	strikeoutThickness: number;
}

const metricsOfFamilies = new Map<FontFamily, FamilyMetrics>();

export function metricsOf(family: FontFamily): FamilyMetrics {
	const known = metricsOfFamilies.get(family);
	if (known) return known;
	const { font } = filesOf({ family, weight: 400, italic: false })[0];
	const perEm = font.unitsPerEm;
	const metrics = {
		ascent: font.ascent / perEm,
		descent: -font.descent / perEm,
		underlinePosition: -font.underlinePosition / perEm,
		underlineThickness: font.underlineThickness / perEm,
		strikeoutPosition: font["OS/2"].yStrikeoutPosition / perEm,
		strikeoutThickness: font["OS/2"].yStrikeoutSize / perEm,
	};
	metricsOfFamilies.set(family, metrics);
	return metrics;
}
