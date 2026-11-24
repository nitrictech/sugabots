/*
 * The markdown a `document` artifact is kept as. Markdown has no sign for
 * underline, superscript, subscript or highlight, so it writes each as the
 * HTML tag that draws it, as `<sup>2</sup>`, and joins a table cell's lines
 * with `<br>`. The editor's schema reads and writes exactly these (see
 * `live-document.ts`), and whatever draws or converts the markdown lets
 * exactly these through as HTML (`allowedHtmlTag`), showing any other HTML as
 * the text it is.
 */

/** The marks markdown has no sign for, by the editor's name for each, with the HTML tag it is written as. */
export const MARK_HTML_TAGS = {
	underline: "u",
	superscript: "sup",
	subscript: "sub",
	highlight: "mark",
} as const;

/** A mark the markdown writes as an HTML tag. */
export type MarkWrittenAsHtml = keyof typeof MARK_HTML_TAGS;

type MarkHtmlTag = (typeof MARK_HTML_TAGS)[MarkWrittenAsHtml];

/** `<br>` at the start of some markdown: the line break between the lines of a table cell. */
export const LINE_BREAK_TAG = /^<br\s*\/?>/i;

/** One of the HTML tags a document's markdown is written with: a mark's opening or closing tag, or a line break. */
export type AllowedHtmlTag =
	| { name: MarkHtmlTag; closing: boolean }
	| { name: "br"; closing: false };

const MARK_TAG_NAMES: readonly string[] = Object.values(MARK_HTML_TAGS);

/**
 * `html`, a piece of raw HTML in a document's markdown, when it is exactly
 * one of the tags the markdown is written with: `undefined` for anything
 * else, attributes and all, which is shown as its text.
 */
export function allowedHtmlTag(html: string): AllowedHtmlTag | undefined {
	const trimmed = html.trim();
	if (LINE_BREAK_TAG.exec(trimmed)?.[0] === trimmed) return { name: "br", closing: false };
	const [, closing, name] = /^<(\/?)([a-z]+)>$/i.exec(trimmed) ?? [];
	const tag = name?.toLowerCase();
	return tag && MARK_TAG_NAMES.includes(tag)
		? { name: tag as MarkHtmlTag, closing: closing === "/" }
		: undefined;
}
