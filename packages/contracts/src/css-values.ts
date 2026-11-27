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
 * as `rgb(30 41 59 / 50%)`, or a keyword such as `white`. Only `cssColorIn`
 * makes one, so a colour written into `background` can't name an image, which
 * every browser drawing the deck would fetch.
 */
export type CssColor = string & { readonly [cssColorParsed]: true };

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A colour function whose arguments are numbers, percentages, angles and the separators between them, never another function. */
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\)$/i;

const COLOR_KEYWORD = /^[a-z]+$/i;

/** Keywords CSS takes where a colour goes that are no colour: none at all, or whatever the cascade gives. */
const NOT_COLORS = new Set(["none", "inherit", "initial", "unset", "revert", "auto"]);

/** `value` as a CSS colour, trimmed, or `null` when it is no colour `CssColor` allows, as `none`. */
export function cssColorIn(value: unknown): CssColor | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (NOT_COLORS.has(trimmed.toLowerCase())) return null;
	const isColor =
		HEX_COLOR.test(trimmed) || COLOR_FUNCTION.test(trimmed) || COLOR_KEYWORD.test(trimmed);
	return isColor ? (trimmed as CssColor) : null;
}

/**
 * The finite number of pixels `value` says, as `24px`, or as a bare number,
 * which a bot may write for pixels: `undefined` for anything else, as a
 * length in another unit, which can't be told in pixels without what it is
 * relative to.
 */
export function pixelsIn(value: string | null | undefined): number | undefined {
	const [, number] =
		/^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:px)?\s*$/i.exec(value ?? "") ?? [];
	if (number === undefined) return undefined;
	const pixels = Number(number);
	return Number.isFinite(pixels) ? pixels : undefined;
}

/** `value` as a CSS length in pixels, as a deck's HTML writes every length on a slide. */
export const pixels = (value: number): string => `${value}px`;

/**
 * An element of a page being read, as far as reading its inline style goes.
 * The API reads HTML with a DOM of its own and is built without the
 * browser's types, so an element is typed by the little of it that is read.
 */
export interface StyledElement {
	getAttribute(name: string): string | null;
}

/**
 * The value `element`'s inline style gives `property`, as written: the last
 * declaration of it, as CSS takes the last, or `null` when there is none.
 * It is read from the `style` attribute itself, as a browser's own reading
 * rewrites a value in its own words, such as a hex colour as `rgb()`.
 */
export function styleProperty(element: StyledElement, property: string): string | null {
	const wanted = property.toLowerCase();
	const declarations = (element.getAttribute("style") ?? "").split(";").toReversed();
	for (const declaration of declarations) {
		const colon = declaration.indexOf(":");
		if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() !== wanted) continue;
		return declaration.slice(colon + 1).trim();
	}
	return null;
}
