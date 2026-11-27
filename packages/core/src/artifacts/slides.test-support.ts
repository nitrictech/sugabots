import { deckFromHtml } from "@sugabots/contracts/deck-html";
import type { Frame } from "@sugabots/contracts/slide-geometry";
import type { Node } from "@tiptap/pm/model";
import { readHtml } from "./html-reader.ts";

/** The deck `html`, a deck's HTML as bots write it (see `deck-html.ts`), reads as on the server. */
export const deckOf = (html: string): Node => deckFromHtml(html, readHtml);

/** How a box is drawn, beyond what it holds, as its HTML says it. */
interface BoxHtml {
	role?: string;
	/** Its frame; left out, it is where its slide's layout puts a box of its role. */
	frame?: Frame;
	/** The rest of its style, such as `background: #1e3a8a; padding: 8px`. */
	style?: string;
	verticalAlign?: "middle" | "bottom";
	/** The path of its shape, in its frame's own pixels. */
	path?: string;
}

/** A box's HTML, holding `content`, a box's blocks' HTML. */
export function boxHtml(
	content: string,
	{ role, frame, style, verticalAlign, path }: BoxHtml = {},
) {
	const frameStyle = frame
		? `left: ${frame.x}px; top: ${frame.y}px; width: ${frame.width}px; height: ${frame.height}px`
		: "";
	const styles = [frameStyle, style ?? ""].filter((each) => each !== "").join("; ");
	const shape =
		path && frame
			? `<svg viewBox="0 0 ${frame.width} ${frame.height}"><path d="${path}" fill="${shapeFill(style)}"/></svg>`
			: "";
	return [
		"<div data-slide-box",
		role ? ` data-role="${role}"` : "",
		verticalAlign ? ` data-vertical-align="${verticalAlign}"` : "",
		styles ? ` style="${styles}"` : "",
		`>${shape}${content}</div>`,
	].join("");
}

/** The fill a shape's drawing is given: the box's background, which a shape is filled with in its drawing. */
const shapeFill = (style = "") => /background:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? "none";

/** How a slide is drawn, beyond its boxes, as its HTML says it. */
interface SlideHtml {
	layout?: string;
	background?: string;
	/** Its speaker notes' HTML. */
	notes?: string;
}

/** A slide's HTML, holding `boxes`, each a box's HTML (`boxHtml`). */
export function slideHtml(boxes: readonly string[], { layout, background, notes }: SlideHtml = {}) {
	return [
		"<section data-slide",
		layout ? ` data-layout="${layout}"` : "",
		background ? ` style="background: ${background}"` : "",
		`><div data-slide-body>${boxes.join("")}</div>`,
		notes ? `<aside data-speaker-notes>${notes}</aside>` : "",
		"</section>",
	].join("");
}
