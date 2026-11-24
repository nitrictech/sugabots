import { layoutOf, SLIDE_COLUMN, SPEAKER_NOTES } from "@sugabots/contracts/live-slides";
import type { SlideLayout } from "@sugabots/contracts/slides-markdown";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { keepSlidesFitting, type PlacedSlide, slideIndexAt, slidesOf } from "@/lib/deck.ts";

/*
 * The stage a deck is edited on. One editor holds the whole deck, and the
 * stage shows the slide the selection is in: the others stay in the editor,
 * hidden, so nothing anyone types in them is lost or redrawn. The slide in
 * view says what goes in each of its empty parts, and holds a place under its
 * frame for what the stage puts there.
 */

interface Stage {
	/** The index of the slide in view. */
	current: number;
	decorations: DecorationSet;
}

const stageKey = new PluginKey<Stage>("deckStage");

/** The index of the slide in view on the stage: the one the selection is in. */
export const slideInView = (state: EditorState): number => stageKey.getState(state)?.current ?? 0;

/**
 * The stage's part of a deck's editor. It draws an element under the frame of
 * the slide in view, above its notes, for the stage to put things in, and
 * tells `onUnderSlide` which element that is now, as a change to the one it
 * was: a new one each time it draws one, and none once the one there is gone. `onAddImage` is asked for an image for the empty column,
 * starting at `column`, of a slide laid out with an image, with the file
 * dropped there if one was.
 */
export function deckStage({
	onUnderSlide,
	onAddImage,
}: {
	onUnderSlide: (change: (element: HTMLElement | undefined) => HTMLElement | undefined) => void;
	onAddImage: (column: number, file: File | undefined) => void;
}) {
	const underSlide: UnderSlide = {
		// A new element each time the editor draws one: one it drew before may still be in its old place.
		draw: () => {
			const element = document.createElement("div");
			element.className = "slide-under";
			onUnderSlide(() => element);
			return element;
		},
		gone: (element) => onUnderSlide((current) => (current === element ? undefined : current)),
	};
	const stageOf = (state: EditorState): Stage => {
		const current = slideIndexAt(state.doc, state.selection.head);
		const slides = slidesOf(state.doc);
		const shown = slides[current];
		return {
			current,
			decorations: DecorationSet.create(state.doc, [
				...slides
					.filter(({ index }) => index !== current)
					.map(({ node, pos }) =>
						Decoration.node(pos, pos + node.nodeSize, { class: "slide-elsewhere" }),
					),
				...(shown ? decorationsInView(shown, underSlide, onAddImage) : []),
			]),
		};
	};
	return Extension.create({
		name: "deckStage",
		addProseMirrorPlugins() {
			return [
				keepSlidesFitting,
				new Plugin<Stage>({
					key: stageKey,
					state: {
						init: (_config, state) => stageOf(state),
						apply(transaction, stage, _before, state) {
							if (
								!transaction.docChanged &&
								slideIndexAt(state.doc, state.selection.head) === stage.current
							) {
								return stage;
							}
							return stageOf(state);
						},
					},
					props: {
						decorations: (state) => stageKey.getState(state)?.decorations,
					},
				}),
			];
		},
	});
}

function decorationsInView(
	{ node: slide, pos }: PlacedSlide,
	underSlide: UnderSlide,
	onAddImage: (column: number, file: File | undefined) => void,
): Decoration[] {
	const body = slide.child(0);
	const bodyStart = pos + 2;
	const afterBody = pos + 1 + body.nodeSize;
	return [
		...emptyPartsOf(body, bodyStart, layoutOf(slide)).map(({ node, at, words }) =>
			words === ADD_IMAGE
				? Decoration.widget(at + 1, imageArea(onAddImage), {
						key: "add-image",
						side: -1,
						stopEvent: () => true,
						ignoreSelection: true,
					})
				: Decoration.node(at, at + node.nodeSize, { class: "is-empty", "data-placeholder": words }),
		),
		...notesHint(slide.child(1), afterBody),
		Decoration.widget(afterBody, underSlide.draw, {
			key: "under-slide",
			side: 1,
			stopEvent: () => true,
			ignoreSelection: true,
			destroy: underSlide.gone,
		}),
	];
}

/** Drawing the element under the slide in view, and saying it is gone. */
interface UnderSlide {
	draw: () => HTMLElement;
	gone: (element: globalThis.Node) => void;
}

/** Stands for the place an image goes in, which is drawn as an area to add one, not as words. */
const ADD_IMAGE = Symbol("an image");

/** An empty part of a slide's frame, where it starts, and what goes there. */
interface EmptyPart {
	node: Node;
	at: number;
	words: string | typeof ADD_IMAGE;
}

/**
 * The empty parts of a slide's frame, `body`, which starts at `start`, with
 * what goes in each as the slide's layout has it: a title, a subtitle under
 * it, a quote and who said it, text, and in the second column of a slide
 * laid out with an image, the image.
 */
function emptyPartsOf(body: Node, start: number, layout: SlideLayout): EmptyPart[] {
	const parts: EmptyPart[] = [];
	let titled = false;
	let column = 0;
	body.forEach((child, offset, index) => {
		const at = start + offset;
		const before = index > 0 ? body.child(index - 1) : undefined;
		if (child.type.name === SLIDE_COLUMN) {
			if (layout === "image" && column === 1 && holdsOnlyAnEmptyParagraph(child)) {
				parts.push({ node: child, at, words: ADD_IMAGE });
			} else {
				parts.push(...emptyTextIn(child, at + 1, "Add text"));
			}
			column++;
			return;
		}
		if (child.type.name === "heading") {
			if (child.content.size === 0)
				parts.push({ node: child, at, words: titled ? "Add a heading" : "Add a title" });
			titled = true;
			return;
		}
		if (child.type.name === "paragraph") {
			if (child.content.size === 0)
				parts.push({ node: child, at, words: paragraphWords(layout, titled, before) });
			return;
		}
		parts.push(
			...emptyTextIn(child, at + 1, child.type.name === "blockquote" ? "Add a quote" : "Add text"),
		);
	});
	return parts;
}

/** What goes in an empty paragraph of a slide's own, where `before` is the block above it. */
function paragraphWords(layout: SlideLayout, titled: boolean, before: Node | undefined): string {
	if (layout === "title" && titled) return "Add a subtitle";
	if (layout === "section") return titled ? "Add a subtitle" : "Add a label";
	if (layout === "quote" && before?.type.name === "blockquote") return "Who said it";
	return "Add text";
}

/** The empty lines of text in `node`, whose content starts at `start`, but for those in a table or code. */
function emptyTextIn(node: Node, start: number, words: string): EmptyPart[] {
	const parts: EmptyPart[] = [];
	node.descendants((child, offset) => {
		if (child.type.name === "table" || child.type.name === "codeBlock") return false;
		if (child.isTextblock && child.content.size === 0) {
			parts.push({
				node: child,
				at: start + offset,
				words: child.type.name === "heading" ? "Add a heading" : words,
			});
		}
		return !child.isTextblock;
	});
	return parts;
}

const holdsOnlyAnEmptyParagraph = (region: Node) =>
	region.childCount === 1 &&
	region.firstChild?.type.name === "paragraph" &&
	region.firstChild.content.size === 0;

/** Says what the notes under a slide are for, while they say nothing. */
function notesHint(notes: Node, start: number): Decoration[] {
	const first = notes.firstChild;
	if (
		notes.type.name !== SPEAKER_NOTES ||
		!first ||
		notes.textContent !== "" ||
		notes.childCount > 1
	)
		return [];
	return [
		Decoration.node(start + 1, start + 1 + first.nodeSize, {
			class: "is-empty",
			"data-placeholder": "Add notes only you see while presenting",
		}),
	];
}

/**
 * The area an empty image column is drawn as: a dashed frame saying to add
 * an image, which opens the picker for one when pressed, and takes one
 * dropped on it.
 */
const imageArea =
	(onAddImage: (column: number, file: File | undefined) => void) =>
	(_view: unknown, getPos: () => number | undefined) => {
		const area = document.createElement("button");
		area.type = "button";
		area.className = "slide-add-image";
		area.contentEditable = "false";
		area.append(
			pictureIcon(),
			Object.assign(document.createElement("span"), { textContent: "Add an image" }),
		);
		/** Where the column starts: the area is drawn at the start of what it holds. */
		const column = () => {
			const at = getPos();
			return at === undefined ? undefined : at - 1;
		};
		area.addEventListener("click", () => {
			const at = column();
			if (at !== undefined) onAddImage(at, undefined);
		});
		area.addEventListener("dragover", (event) => {
			if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
		});
		area.addEventListener("drop", (event) => {
			const [file] = event.dataTransfer?.files ?? [];
			const at = column();
			if (!file || at === undefined) return;
			event.preventDefault();
			onAddImage(at, file);
		});
		return area;
	};

/** A picture's outline: a frame with hills and a sun, drawn as the design draws it. */
function pictureIcon(): SVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.25");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	const path = document.createElementNS(SVG, "path");
	path.setAttribute("d", "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5M10.5 6h.01");
	svg.append(path);
	return svg;
}

const SVG = "http://www.w3.org/2000/svg";
