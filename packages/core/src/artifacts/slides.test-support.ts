import {
	bodyOf,
	FIRST_BOX_IN_SLIDE,
	PLACEMENT,
	takeBoxOffSlide,
} from "@sugabots/contracts/live-slides";
import type { Frame } from "@sugabots/contracts/slides-markdown";
import type { Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

/** The words of `slide`'s first heading: its title, on any layout. `undefined` when it holds no heading. */
export function titleOf(slide: Node): string | undefined {
	let title: string | undefined;
	slide.descendants((node) => {
		if (title === undefined && node.type.name === "heading") title = node.textContent;
		return title === undefined;
	});
	return title;
}

/** Where the slide at `slide` of `deck` starts. */
function slideStart(deck: Node, slide: number): number {
	let at = 0;
	for (let index = 0; index < slide; index++) at += deck.child(index).nodeSize;
	return at;
}

/** `deck` with the boxes of its slide at `slide` placed at `frames`, as only a person's editor places them. */
export function withSlidePlaced(deck: Node, slide: number, frames: readonly Frame[]): Node {
	return new Transform(deck).setNodeAttribute(slideStart(deck, slide), PLACEMENT, frames).doc;
}

/** `deck` with the box at `box` of its slide at `slide` removed from it, as a person's editor removes one. */
export function withBoxRemoved(deck: Node, slide: number, box: number): Node {
	const body = bodyOf(deck.child(slide));
	let at = slideStart(deck, slide) + FIRST_BOX_IN_SLIDE;
	for (let index = 0; index < box; index++) at += body.child(index).nodeSize;
	return takeBoxOffSlide(new Transform(deck), at).doc;
}
