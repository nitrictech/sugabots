import { Extension, type Extensions } from "@tiptap/core";
import { TextAlign } from "@tiptap/extension-text-align";
import { Color } from "@tiptap/extension-text-style/color";
import { FontFamily } from "@tiptap/extension-text-style/font-family";
import { TextStyle } from "@tiptap/extension-text-style/text-style";
import type { ParseRule, TagParseRule } from "@tiptap/pm/model";
import { pixels, pixelsIn, type StyledElement, styleProperty } from "./css-values.ts";

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
 *   the size in a slide's pixels, as every length on a slide is (see
 *   `slide-geometry.ts`);
 * - `<p style="text-align: center; line-height: 1.2">`, the line height a
 *   multiple of the text's size.
 *
 * Text with none of these is drawn as the slide styles draw text of its box's
 * role, at the size they step it to so that it fits (`SLIDE_TEXT_STEPS`). A
 * size set here is the size the text is drawn at: it never steps down.
 */

/** The mark a stretch of text's colour, font and size are attributes of. */
export const TEXT_STYLE = "textStyle";

/** The blocks whose alignment and line height may be set: those whose lines are text. */
const TEXT_BLOCKS = ["paragraph", "heading"];

/** A stretch of text's size, in a slide's pixels, as a `font-size` in pixels says it: `null` for any other. */
function fontSizeIn(element: StyledElement): number | null {
	const size = pixelsIn(styleProperty(element, "font-size"));
	return size !== undefined && size > 0 ? size : null;
}

const isFontSize = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

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
					parseHTML: fontSizeIn,
					renderHTML: ({ fontSize }) =>
						isFontSize(fontSize) ? { style: `font-size: ${pixels(fontSize)}` } : {},
				},
			},
		},
	],
});

/** A line height as `line-height` says it: a multiple of the text's size, or a percentage of it. `null` for any other. */
function lineHeightIn(element: StyledElement): number | null {
	const [, number, percent] =
		/^\s*(\d+\.?\d*|\.\d+)\s*(%)?\s*$/.exec(styleProperty(element, "line-height") ?? "") ?? [];
	if (number === undefined) return null;
	const multiple = percent ? Number(number) / 100 : Number(number);
	return multiple > 0 && Number.isFinite(multiple) ? multiple : null;
}

const isLineHeight = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

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
					parseHTML: lineHeightIn,
					renderHTML: ({ lineHeight }) =>
						isLineHeight(lineHeight) ? { style: `line-height: ${lineHeight}` } : {},
				},
			},
		},
	],
});

/** What CSS says of a stretch of text that the `textStyle` mark keeps. */
const saysKeptStyle = (element: StyledElement) =>
	styleProperty(element, "color") !== null ||
	styleProperty(element, "font-family") !== null ||
	fontSizeIn(element) !== null;

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
						getAttrs: (element: RuleElement) =>
							saysKeptStyle(element) && (rule.getAttrs?.(element) ?? null),
					}
				: rule,
		);
	},
});

const isTagRule = (rule: ParseRule): rule is TagParseRule => typeof rule.tag === "string";

/**
 * The element a tag rule reads, as the parser gives it: named through the
 * rule's own type, as the API is built without the browser's.
 */
type RuleElement = Parameters<NonNullable<TagParseRule["getAttrs"]>>[0];

/**
 * What styles a deck's text, as the text style and text align packages do,
 * but for a stretch of text's size and a block's line height, which are
 * numbers here (see `FontSize` and `BlockLineHeight`). The packages' commands
 * for colour, font and alignment (`setColor`, `setFontFamily`,
 * `setTextAlign`) work as they document; their `setFontSize` and
 * `setLineHeight` are not registered.
 */
export const slideTextStyles: Extensions = [
	SlideTextStyle,
	Color,
	FontFamily,
	FontSize,
	TextAlign.configure({ types: TEXT_BLOCKS }),
	BlockLineHeight,
];
