/*
 * CSS values a deck stores and writes into its HTML's inline styles, read
 * from what people's editors, imported files and bots give. A value is kept
 * only once it is known to be one declaration's value of its kind and
 * nothing else, as a stored value is written back into a `style` attribute
 * that everybody's browser draws.
 */

declare const cssColorParsed: unique symbol;

/**
 * A CSS colour as written: a hex colour, a colour function of numbers such
 * as `rgb(30 41 59 / 50%)`, or one of CSS's colour names, such as `white`.
 * Only `cssColorIn` makes one, so a colour written into `background` can't
 * name an image, which every browser drawing the deck would fetch, nor be a
 * word that is no colour, as `solid` in a border.
 */
export type CssColor = string & { readonly [cssColorParsed]: true };

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour function whose arguments are numbers, percentages, angles and the separators between them, never another function. */
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\)$/i;

/** CSS's colour names, and the two keywords that are colours too: none at all, and the colour of the text. */
const COLOR_NAMES: ReadonlySet<string> = new Set([
	"transparent",
	"currentcolor",
	"aliceblue",
	"antiquewhite",
	"aqua",
	"aquamarine",
	"azure",
	"beige",
	"bisque",
	"black",
	"blanchedalmond",
	"blue",
	"blueviolet",
	"brown",
	"burlywood",
	"cadetblue",
	"chartreuse",
	"chocolate",
	"coral",
	"cornflowerblue",
	"cornsilk",
	"crimson",
	"cyan",
	"darkblue",
	"darkcyan",
	"darkgoldenrod",
	"darkgray",
	"darkgreen",
	"darkgrey",
	"darkkhaki",
	"darkmagenta",
	"darkolivegreen",
	"darkorange",
	"darkorchid",
	"darkred",
	"darksalmon",
	"darkseagreen",
	"darkslateblue",
	"darkslategray",
	"darkslategrey",
	"darkturquoise",
	"darkviolet",
	"deeppink",
	"deepskyblue",
	"dimgray",
	"dimgrey",
	"dodgerblue",
	"firebrick",
	"floralwhite",
	"forestgreen",
	"fuchsia",
	"gainsboro",
	"ghostwhite",
	"gold",
	"goldenrod",
	"gray",
	"green",
	"greenyellow",
	"grey",
	"honeydew",
	"hotpink",
	"indianred",
	"indigo",
	"ivory",
	"khaki",
	"lavender",
	"lavenderblush",
	"lawngreen",
	"lemonchiffon",
	"lightblue",
	"lightcoral",
	"lightcyan",
	"lightgoldenrodyellow",
	"lightgray",
	"lightgreen",
	"lightgrey",
	"lightpink",
	"lightsalmon",
	"lightseagreen",
	"lightskyblue",
	"lightslategray",
	"lightslategrey",
	"lightsteelblue",
	"lightyellow",
	"lime",
	"limegreen",
	"linen",
	"magenta",
	"maroon",
	"mediumaquamarine",
	"mediumblue",
	"mediumorchid",
	"mediumpurple",
	"mediumseagreen",
	"mediumslateblue",
	"mediumspringgreen",
	"mediumturquoise",
	"mediumvioletred",
	"midnightblue",
	"mintcream",
	"mistyrose",
	"moccasin",
	"navajowhite",
	"navy",
	"oldlace",
	"olive",
	"olivedrab",
	"orange",
	"orangered",
	"orchid",
	"palegoldenrod",
	"palegreen",
	"paleturquoise",
	"palevioletred",
	"papayawhip",
	"peachpuff",
	"peru",
	"pink",
	"plum",
	"powderblue",
	"purple",
	"rebeccapurple",
	"red",
	"rosybrown",
	"royalblue",
	"saddlebrown",
	"salmon",
	"sandybrown",
	"seagreen",
	"seashell",
	"sienna",
	"silver",
	"skyblue",
	"slateblue",
	"slategray",
	"slategrey",
	"snow",
	"springgreen",
	"steelblue",
	"tan",
	"teal",
	"thistle",
	"tomato",
	"turquoise",
	"violet",
	"wheat",
	"white",
	"whitesmoke",
	"yellow",
	"yellowgreen",
]);

/** `value` as a CSS colour, trimmed and as written, or `null` when it is no colour `CssColor` allows. */
export function cssColorIn(value: unknown): CssColor | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const isColor =
		HEX_COLOR.test(trimmed) ||
		COLOR_FUNCTION.test(trimmed) ||
		COLOR_NAMES.has(trimmed.toLowerCase());
	return isColor ? (trimmed as CssColor) : null;
}

declare const fontFamilyParsed: unique symbol;

/**
 * A list of font families as CSS writes one, such as `"Source Serif",
 * Georgia, serif`: each family a name of letters of any script, digits,
 * spaces, hyphens and underscores, or such a name in quotes, which may also
 * hold dots, commas, ampersands, pluses and the other kind of quote. Only
 * `fontFamilyIn` makes one, so it names fonts and nothing else, never a
 * `url(…)`.
 */
export type FontFamilies = string & { readonly [fontFamilyParsed]: true };

const FAMILY_NAME = /^(?:[\p{L}\p{N}_ -]+|"[\p{L}\p{N}_ .,&'+-]+"|'[\p{L}\p{N}_ .,&"+-]+')$/u;

/** `value` as a list of font families, trimmed and as written, or `null` when it lists anything else. */
export function fontFamilyIn(value: unknown): FontFamilies | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const families = splitFamilies(trimmed);
	const named = families.length > 0 && families.every((family) => FAMILY_NAME.test(family));
	return named ? (trimmed as FontFamilies) : null;
}

/** The families a list of them names, split at each comma outside quotes, each trimmed. */
function splitFamilies(list: string): string[] {
	const families: string[] = [];
	let quote: string | undefined;
	let family = "";
	for (const character of list) {
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ",") {
			families.push(family.trim());
			family = "";
			continue;
		}
		family += character;
	}
	return quote ? [] : [...families, family.trim()];
}

/**
 * A number as CSS and SVG write one, as a regular expression's source: a
 * sign, digits with or without a point, and an exponent, as `-1.5e-7`.
 */
export const NUMBER_PATTERN = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;

const PIXELS = new RegExp(String.raw`^\s*(${NUMBER_PATTERN})(?:px)?\s*$`, "i");

/**
 * The finite number of pixels `value` says, as `24px`, or as a bare number,
 * which a bot may write for pixels: `undefined` for anything else, as a
 * length in another unit, which can't be told in pixels without what it is
 * relative to.
 */
export function pixelsIn(value: string | null | undefined): number | undefined {
	const [, number] = PIXELS.exec(value ?? "") ?? [];
	const pixels = Number(number);
	return number !== undefined && Number.isFinite(pixels) ? pixels : undefined;
}

/** `value` as a CSS length in pixels, as a deck's HTML writes every length on a slide. */
export const pixels = (value: number): string => `${value}px`;

export const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/** `value`, a number, at least `least` and at most `most`. */
export const within = (value: number, least: number, most: number): number =>
	Math.min(most, Math.max(least, value));
