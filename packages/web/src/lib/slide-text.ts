import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import type { Node } from "@tiptap/pm/model";

/*
 * The sizes a slide's text is drawn at: the size the slide styles give what a
 * box is for, stepped down to fit, or a size of its own (see
 * `slide-text-style.ts`), as text from a PowerPoint file has. An element is
 * spaced by the size it is drawn at, whatever its text's, so a line, a list
 * and a list's item whose text all has a size of its own are drawn at it too.
 */

/**
 * The size `line`, a paragraph or heading, is drawn at when every bit of its
 * text has a size of its own: the largest of them, in a slide's pixels.
 * `undefined` for a line holding no text, or any text sized by the slide
 * styles.
 */
export function ownTextSizeOf(line: Node): number | undefined {
	let largest: number | undefined;
	let styled = true;
	line.forEach((inline) => {
		if (!inline.isText) return;
		const size = sizeOfText(inline);
		if (size === undefined) styled = false;
		else largest = Math.max(largest ?? 0, size);
	});
	return styled ? largest : undefined;
}

/** The size `text`, a run of a slide's text, has of its own, if it has one. */
export function sizeOfText(text: Node): number | undefined {
	const size: unknown = text.marks.find((mark) => mark.type.name === TEXT_STYLE)?.attrs.fontSize;
	return typeof size === "number" ? size : undefined;
}

/** The lists a slide's boxes hold. */
const LISTS = new Set(["bulletList", "orderedList"]);

/**
 * The size `node` is drawn at, when it is one drawn at its text's own size: a
 * line (`ownTextSizeOf`); a list's item, by its first line, so its marker and
 * the space around it are as large as its text; and a list, by its first
 * item, so the room it leaves for markers and between its items is too.
 * `undefined` for any other node, or one drawn at the slide styles' size.
 */
export function drawnTextSizeOf(node: Node): number | undefined {
	if (node.isTextblock) return ownTextSizeOf(node);
	if (node.type.name === "listItem" || LISTS.has(node.type.name)) {
		return node.firstChild ? drawnTextSizeOf(node.firstChild) : undefined;
	}
	return undefined;
}

/**
 * The nodes of a slide's body that `drawnTextSizeOf` may size, by the
 * elements the schema draws each as, so a drawing of the slide can find them
 * in the order the slide holds them.
 */
export const SIZED_BY_THEIR_TEXT: Readonly<Record<string, string>> = {
	paragraph: "p",
	heading: "h1, h2, h3, h4, h5, h6",
	listItem: "li",
	bulletList: "ul",
	orderedList: "ol",
};
