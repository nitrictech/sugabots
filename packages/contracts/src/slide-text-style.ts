import { Extension, type Extensions, getStyleProperty } from "@tiptap/core";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-text-style/color";
import { FontFamily } from "@tiptap/extension-text-style/font-family";
import { TextStyle } from "@tiptap/extension-text-style/text-style";
import type { ParseRule, TagParseRule } from "@tiptap/pm/model";
import {
	cssColorIn,
	fontFamilyIn,
	isFiniteNumber,
	NUMBER_PATTERN,
	pixels,
	pixelsIn,
	within,
} from "./css-values.ts";
import type { PageElement } from "./page-element.ts";

/*
 * How text on a slide may be styled beyond its marks, as a file made in
 * another app styles it: a stretch of text's colour, font and size, as the
 * `textStyle` mark's attributes, and a paragraph's or heading's alignment
 * and line height, as its own. Decks alone hold these; a document's text is
 * styled by its blocks and marks only.
 *
 * Each is written as the inline style a browser draws it by, which is how a
 * deck's HTML says it (see `deck-html.ts`):
 *
 * - `<span style="color: #1e3a8a; font-family: Georgia, serif; font-size: 24px">`,
 *   the colour a `CssColor`, the font a list of `FontFamilies`, and the size
 *   in a slide's pixels, as every length on a slide is (see
 *   `slide-geometry.ts`);
 * - `<p style="text-align: center; line-height: 1.2">`, the line height a
 *   multiple of the text's size.
 *
 * Each is read through its reader here, as a box's attributes are, so what
 * an exporter reads is always of its kind and within bounds.
 *
 * Text with none of these is drawn as the slide styles draw text of its box's
 * role, at the size they step it to so that it fits (`SLIDE_TEXT_STEPS`). A
 * size set here is the size the text is drawn at: it never steps down.
 */

/** The mark a stretch of text's colour, font and size are attributes of. */
export const TEXT_STYLE = "textStyle";

/** The blocks whose alignment and line height may be set: those whose lines are text. */
const TEXT_BLOCKS = ["paragraph", "heading"];

/** The sizes text may be, in a slide's pixels: the range PowerPoint holds. */
export const TEXT_SIZES = { least: 1, most: 4000 } as const;

/** The most a line may be tall, as a multiple of its text's size: far more space than any slide shows. */
export const MOST_LINE_HEIGHT = 100;

/**
 * `value` as a stretch of text's size, in a slide's pixels: `null` unless it
 * is a finite number above 0, and one outside `TEXT_SIZES` read as the
 * nearest size within them.
 */
export const textSizeIn = (value: unknown): number | null =>
	isFiniteNumber(value) && value > 0 ? within(value, TEXT_SIZES.least, TEXT_SIZES.most) : null;

/**
 * `value` as a paragraph's or heading's line height, a multiple of its
 * text's size: `null` unless it is a finite number above 0, and one over
 * `MOST_LINE_HEIGHT` read as that.
 */
export const lineHeightIn = (value: unknown): number | null =>
	isFiniteNumber(value) && value > 0 ? Math.min(value, MOST_LINE_HEIGHT) : null;

/** A stretch of text's size as its `font-size` says it in pixels (see `textSizeIn`). */
const fontSizeOf = (element: PageElement) =>
	textSizeIn(pixelsIn(getStyleProperty(element, "font-size")));

/** A line height as `line-height` says it, a multiple of the text's size, or a percentage of it. */
const LINE_HEIGHT = new RegExp(String.raw`^\s*(${NUMBER_PATTERN})\s*(%)?\s*$`, "i");

function lineHeightOf(element: PageElement): number | null {
	const [, number, percent] =
		LINE_HEIGHT.exec(getStyleProperty(element, "line-height") ?? "") ?? [];
	if (number === undefined) return null;
	return lineHeightIn(percent ? Number(number) / 100 : Number(number));
}

/**
 * A stretch of text's colour, `color` on the `textStyle` mark, read and
 * written as a `CssColor`, as a box's fill is. The text style package's
 * `setColor` and `unsetColor` set it.
 */
const SlideColor = Color.extend({
	addGlobalAttributes() {
		return [
			{
				types: this.options.types,
				attributes: {
					color: {
						default: null,
						parseHTML: (element) => cssColorIn(getStyleProperty(element, "color")),
						renderHTML: ({ color }) => {
							const known = cssColorIn(color);
							return known ? { style: `color: ${known}` } : {};
						},
					},
				},
			},
		];
	},
});

/**
 * A stretch of text's font, `fontFamily` on the `textStyle` mark, read and
 * written as a list of `FontFamilies`. The text style package's
 * `setFontFamily` and `unsetFontFamily` set it.
 */
const SlideFontFamily = FontFamily.extend({
	addGlobalAttributes() {
		return [
			{
				types: this.options.types,
				attributes: {
					fontFamily: {
						default: null,
						parseHTML: (element) => fontFamilyIn(getStyleProperty(element, "font-family")),
						renderHTML: ({ fontFamily }) => {
							const known = fontFamilyIn(fontFamily);
							return known ? { style: `font-family: ${known}` } : {};
						},
					},
				},
			},
		];
	},
});

/**
 * A stretch of text's size, `fontSize` on the `textStyle` mark: a number of
 * a slide's pixels, not CSS, so a size is never relative to what is around
 * it. Set with `setMark("textStyle", { fontSize })`.
 */
const FontSize = Extension.create({
	name: "slideFontSize",
	addGlobalAttributes: () => [
		{
			types: [TEXT_STYLE],
			attributes: {
				fontSize: {
					default: null,
					parseHTML: fontSizeOf,
					renderHTML: ({ fontSize }) => {
						const size = textSizeIn(fontSize);
						return size === null ? {} : { style: `font-size: ${pixels(size)}` };
					},
				},
			},
		},
	],
});

/**
 * A paragraph's or heading's line height, `lineHeight` on the block: a
 * multiple of its text's size. Set with `updateAttributes`. (The text style
 * package's own line height is a stretch of text's, which can't make a line
 * less tall than its block's.)
 */
const BlockLineHeight = Extension.create({
	name: "blockLineHeight",
	addGlobalAttributes: () => [
		{
			types: TEXT_BLOCKS,
			attributes: {
				lineHeight: {
					default: null,
					parseHTML: lineHeightOf,
					renderHTML: ({ lineHeight }) => {
						const multiple = lineHeightIn(lineHeight);
						return multiple === null ? {} : { style: `line-height: ${multiple}` };
					},
				},
			},
		},
	],
});

/** Whether `element`'s style says something the `textStyle` mark keeps. */
const saysKeptStyle = (element: PageElement) =>
	cssColorIn(getStyleProperty(element, "color")) !== null ||
	fontFamilyIn(getStyleProperty(element, "font-family")) !== null ||
	fontSizeOf(element) !== null;

/**
 * The text style mark, read from a span only when the span's style says
 * something the mark keeps. Any other span would be a mark of no style,
 * which nothing draws and the deck's HTML doesn't write, so it would be gone
 * when the deck is next read.
 */
const SlideTextStyle = TextStyle.extend({
	parseHTML() {
		return (this.parent?.() ?? []).map((rule) =>
			isTagRule(rule)
				? {
						...rule,
						getAttrs: (element: PageElement) =>
							saysKeptStyle(element) && (rule.getAttrs?.(element) ?? null),
					}
				: rule,
		);
	},
});

const isTagRule = (rule: ParseRule): rule is TagParseRule => typeof rule.tag === "string";

/**
 * What styles a deck's text, as the text style and text align packages do,
 * but for a stretch of text's colour and font, read and written through
 * their readers here, and its size and a block's line height, which are
 * numbers here (see `FontSize` and `BlockLineHeight`). The packages' commands
 * for colour, font and alignment (`setColor`, `setFontFamily`,
 * `setTextAlign`) work as they document; their `setFontSize` and
 * `setLineHeight` are not registered.
 */
export const slideTextStyles: Extensions = [
	SlideTextStyle,
	SlideColor,
	SlideFontFamily,
	FontSize,
	TextAlign.configure({ types: TEXT_BLOCKS }),
	BlockLineHeight,
];
