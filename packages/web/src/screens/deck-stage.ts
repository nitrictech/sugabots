import { pixels } from "@sugabots/contracts/css-values";
import {
	backgroundOf,
	bodyOf,
	notesOf,
	SLIDE_BOX,
	SPEAKER_NOTES,
} from "@sugabots/contracts/live-slides";
import type { BoxAttributes, BoxRole } from "@sugabots/contracts/slide-box";
import type { Frame } from "@sugabots/contracts/slide-geometry";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
	boxesOf,
	notesStartInSlide,
	type SlideAt,
	type SlideIndex,
	type SlidePos,
	slideIndexAt,
	slidesOf,
} from "@/lib/deck.ts";
import { type FollowedNode, whereFollowedNodeIs } from "@/lib/followed-node.ts";
import { ownTextSizeOf, SLIDE_PAINT_PROPERTY } from "./slide-drawing.tsx";

/*
 * The stage a deck is edited on. One editor holds the whole deck, and the
 * stage shows the slide the selection is in: the others stay in the editor,
 * hidden, so nothing anyone types in them is lost or redrawn. The slide in
 * view is painted its own colour behind its body alone, not its notes; its
 * lines of text of a size of their own are drawn at it, as a drawing of the
 * slide draws them; what goes in each empty part of its boxes is said there;
 * and it holds a place under its body for what the stage puts there. While
 * one of its boxes is dragged, that box is drawn where the drag has it,
 * until the drag ends.
 */

interface Stage {
	/** The index of the slide in view. */
	current: SlideIndex;
	decorations: DecorationSet;
}

const stageKey = new PluginKey<Stage>("deckStage");

/** The index of the slide in view on the stage: the one the selection is in. */
export const slideInView = (state: EditorState): SlideIndex =>
	stageKey.getState(state)?.current ?? slideIndexAt(state.doc, state.selection.head);

/**
 * The stage's part of a deck's editor. It draws an element under the body of
 * the slide in view, above its notes, for the stage to put things in, and
 * tells `onUnderSlide` which element that is now, as a change to the one it
 * was: a new one each time it draws one, and none once the one there is gone.
 * `onAddImage` is asked for an image for an empty image box, starting at
 * `boxPos`, with the file dropped there if one was.
 */
export function deckStage({
	onUnderSlide,
	onAddImage,
}: {
	onUnderSlide: (change: (element: HTMLElement | undefined) => HTMLElement | undefined) => void;
	onAddImage: (boxPos: number, file: File | undefined) => void;
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
				boxPreview,
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
	{ node: slide, pos }: SlideAt,
	underSlide: UnderSlide,
	onAddImage: (boxPos: number, file: File | undefined) => void,
): Decoration[] {
	const notesStart = pos + notesStartInSlide(slide);
	const background = backgroundOf(slide);
	const boxes = boxesOf(slide).flatMap((box) =>
		emptyPartsOf(box.node, pos + box.startInSlide, box.attributes).map(
			({ node, at: partStart, words }) =>
				words === ADD_IMAGE
					? Decoration.widget(partStart + 1, imageArea(onAddImage), {
							key: "add-image",
							side: -1,
							stopEvent: () => true,
							ignoreSelection: true,
						})
					: Decoration.node(partStart, partStart + node.nodeSize, {
							class: "is-empty",
							"data-placeholder": words,
						}),
		),
	);
	return [
		// The slide's own element holds its notes too: its colour goes to its body (see `app.css`).
		...(background
			? [
					Decoration.node(pos, pos + slide.nodeSize, {
						style: `background: none; ${SLIDE_PAINT_PROPERTY}: ${background}`,
					}),
				]
			: []),
		...linesAtTheirTextSize(slide, pos),
		...boxes,
		...notesHint(notesOf(slide), notesStart),
		Decoration.widget(notesStart, underSlide.draw, {
			key: "under-slide",
			side: 1,
			stopEvent: () => true,
			ignoreSelection: true,
			destroy: underSlide.gone,
		}),
	];
}

/** Each line of the boxes of `slide`, which starts at `slidePos`, whose text has a size of its own, drawn at that size (`ownTextSizeOf`). */
function linesAtTheirTextSize(slide: Node, slidePos: number): Decoration[] {
	const decorations: Decoration[] = [];
	// Past the slide's own start, where its body starts.
	const bodyPos = slidePos + 1;
	bodyOf(slide).descendants((node, offset) => {
		if (!node.isTextblock) return true;
		const size = ownTextSizeOf(node);
		if (size !== undefined) {
			const at = bodyPos + 1 + offset;
			decorations.push(
				Decoration.node(at, at + node.nodeSize, { style: `font-size: ${pixels(size)}` }),
			);
		}
		return false;
	});
	return decorations;
}

/** The element the editor draws the body of the slide starting at `slidePos` as, if it draws it. */
export function drawnSlideBody(view: EditorView, slidePos: SlidePos): HTMLElement | undefined {
	const drawn = view.nodeDOM(slidePos);
	const body =
		drawn instanceof HTMLElement ? drawn.querySelector(":scope > [data-slide-body]") : null;
	return body instanceof HTMLElement ? body : undefined;
}

/** A box of the deck: where it starts now, and the box itself, followed through anybody's changes. */
interface FollowedBox {
	pos: number;
	followed: FollowedNode;
}

/** Where a drag has the box it drags, before it is written. */
export interface BoxPreview {
	box: FollowedBox;
	frame: Frame;
}

const boxPreviewKey = new PluginKey<BoxPreview | null>("boxPreview");

/**
 * Draws `box` at `frame`, as it is dragged, until the drag ends with
 * `withoutBoxPreview`. It changes nothing in the deck, for anybody: the box
 * is only drawn there here, so a drag is written once, when it ends.
 */
export const previewingBox = (state: EditorState, box: FollowedBox, frame: Frame): Transaction =>
	state.tr.setMeta(boxPreviewKey, { box, frame });

/** `transaction`, ending the drawing of a drag's box (see `previewingBox`) as it is made. */
export const withoutBoxPreview = (transaction: Transaction): Transaction =>
	transaction.setMeta(boxPreviewKey, null);

/** Where a drag has the box it drags in `state`, while one does (see `previewingBox`). */
export const boxPreviewOf = (state: EditorState): BoxPreview | null =>
	boxPreviewKey.getState(state) ?? null;

/** The attribute a box being dragged is drawn with, and the properties saying where the drag has it (see `app.css`). */
const DRAGGED_ATTRIBUTE = "data-dragged";
const DRAGGED_FRAME_PROPERTIES = {
	x: "--dragged-x",
	y: "--dragged-y",
	width: "--dragged-width",
	height: "--dragged-height",
} as const satisfies Record<keyof Frame, string>;

/**
 * Drawing the box being dragged where the drag has it, over the frame it
 * holds, and the rest of its slide as it is, others' changes to it included.
 *
 * The box is drawn there by properties of its own, never by its frame's:
 * when a decoration's style goes, the editor takes each property it set off
 * the box, which would take the frame the box's own style draws it at with
 * it.
 *
 * The box is followed through anybody's changes as the drag goes on, and its
 * drawing ends once it is gone. A change made here moves it step by step; a
 * change from elsewhere, or an undo, replaces each slide it touches whole,
 * which reads as the box's deletion, so the box is then looked for where the
 * shared document has it.
 */
const boxPreview = new Plugin<BoxPreview | null>({
	key: boxPreviewKey,
	state: {
		init: () => null,
		apply(transaction, preview, _before, state) {
			const said: BoxPreview | null | undefined = transaction.getMeta(boxPreviewKey);
			if (said !== undefined) return said;
			if (!preview || !transaction.docChanged) return preview;
			const { followed } = preview.box;
			const mapped = transaction.mapping.mapResult(preview.box.pos, 1);
			const pos = mapped.deleted ? whereFollowedNodeIs(state.doc, followed) : mapped.pos;
			if (pos === undefined || state.doc.nodeAt(pos)?.type.name !== SLIDE_BOX) return null;
			return { ...preview, box: { pos, followed } };
		},
	},
	props: {
		decorations(state) {
			const preview = boxPreviewKey.getState(state);
			const box = preview && state.doc.nodeAt(preview.box.pos);
			if (!preview || box?.type.name !== SLIDE_BOX) return null;
			const { pos } = preview.box;
			const frame = Object.entries(DRAGGED_FRAME_PROPERTIES)
				.map(([side, property]) => `${property}: ${pixels(preview.frame[side as keyof Frame])}`)
				.join("; ");
			return DecorationSet.create(state.doc, [
				Decoration.node(pos, pos + box.nodeSize, { [DRAGGED_ATTRIBUTE]: "", style: frame }),
			]);
		},
	},
});

/** Drawing the element under the slide in view, and saying it is gone. */
interface UnderSlide {
	draw: () => HTMLElement;
	gone: (element: globalThis.Node) => void;
}

/** Stands for the place an image goes in, which is drawn as an area to add one, not as words. */
const ADD_IMAGE = Symbol("an image");

/** An empty part of a slide's box, where it starts, and what goes there. */
interface EmptyPart {
	node: Node;
	at: number;
	words: string | typeof ADD_IMAGE;
}

/** What goes on an empty line of a box, by what the box is for. */
const EMPTY_LINE_WORDS: Record<BoxRole, string> = {
	title: "Add a title",
	subtitle: "Add a subtitle",
	body: "Add text",
	leftColumn: "Add text",
	rightColumn: "Add text",
	text: "Add text",
	image: "Add text",
	label: "Add a label",
	quote: "Add a quote",
	attribution: "Who said it",
	table: "Add text",
};

/** What goes on an empty line of a text box for nothing in particular. */
const TEXT_BOX_WORDS = "Add text";

/**
 * The empty parts of a slide's box drawn as `attributes` say, which starts
 * at `start`, with what goes in each: in an image's box, while it holds only
 * an empty line, the image; in any other, on each empty line but those in a
 * table or code, what the box is for, a heading on a heading, and a quote in
 * a quote. In the title's box, the heading it starts with is the title, and a
 * line under it the subtitle. A box painted as a shape or a panel, as one
 * from a PowerPoint file, may be empty by design, and says nothing.
 */
function emptyPartsOf(box: Node, start: number, attributes: BoxAttributes): EmptyPart[] {
	const { role, fill, stroke, path } = attributes;
	if (role === "image" && holdsOnlyAnEmptyParagraph(box)) {
		return [{ node: box, at: start, words: ADD_IMAGE }];
	}
	if (role === null && (fill || stroke || path)) return [];
	const parts: EmptyPart[] = [];
	let titled = false;
	box.descendants((child, offset, parent) => {
		if (child.type.name === "table" || child.type.name === "codeBlock") return false;
		if (!child.isTextblock) return true;
		if (child.content.size === 0) {
			parts.push({
				node: child,
				at: start + 1 + offset,
				words: lineWords(child, parent, role, titled),
			});
		}
		titled ||= child.type.name === "heading";
		return false;
	});
	return parts;
}

/** What goes on `line`, an empty line in `parent`, in a box of `role` that has a heading above it when `titled`. */
function lineWords(line: Node, parent: Node | null, role: BoxRole | null, titled: boolean): string {
	if (line.type.name === "heading")
		return role === "title" && !titled ? "Add a title" : "Add a heading";
	if (parent?.type.name === "blockquote") return "Add a quote";
	if (role === "title" && titled) return "Add a subtitle";
	return role ? EMPTY_LINE_WORDS[role] : TEXT_BOX_WORDS;
}

const holdsOnlyAnEmptyParagraph = (box: Node) =>
	box.childCount === 1 &&
	box.firstChild?.type.name === "paragraph" &&
	box.firstChild.content.size === 0;

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
 * The area an empty image box is drawn as: a dashed outline saying to add an
 * image, which opens the picker for one when pressed, and takes one dropped
 * on it.
 */
const imageArea =
	(onAddImage: (boxPos: number, file: File | undefined) => void) =>
	(_view: unknown, getPos: () => number | undefined) => {
		const area = document.createElement("button");
		area.type = "button";
		area.className = "slide-add-image";
		area.contentEditable = "false";
		area.append(
			pictureIcon(),
			Object.assign(document.createElement("span"), { textContent: "Add an image" }),
		);
		/** Where the box starts: the area is drawn at the start of what it holds. */
		const boxPos = () => {
			const at = getPos();
			return at === undefined ? undefined : at - 1;
		};
		area.addEventListener("click", () => {
			const at = boxPos();
			if (at !== undefined) onAddImage(at, undefined);
		});
		area.addEventListener("dragover", (event) => {
			if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
		});
		area.addEventListener("drop", (event) => {
			const [file] = event.dataTransfer?.files ?? [];
			const at = boxPos();
			if (!file || at === undefined) return;
			event.preventDefault();
			onAddImage(at, file);
		});
		return area;
	};

/** A picture's outline: a rectangle with hills and a sun, drawn as the design draws it. */
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
