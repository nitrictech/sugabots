import {
	notesOf,
	PLACEMENT_ATTRIBUTE,
	placementOf,
	SLIDE,
	SPEAKER_NOTES,
} from "@sugabots/contracts/live-slides";
import type { BoxRole, Frame } from "@sugabots/contracts/slides-markdown";
import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
	boxesOf,
	keepSlidesFitting,
	notesStartInSlide,
	type SlideAt,
	type SlideIndex,
	type SlidePos,
	selectionOutOfRemovedBox,
	slideIndexAt,
	slidesOf,
} from "@/lib/deck.ts";
import { type FollowedNode, whereFollowedNodeIs } from "@/lib/followed-node.ts";
import { boxFrameProperties, drawnBoxAttributes } from "./slide-drawing.tsx";

/*
 * The stage a deck is edited on. One editor holds the whole deck, and the
 * stage shows the slide the selection is in: the others stay in the editor,
 * hidden, so nothing anyone types in them is lost or redrawn. The slide in
 * view says what each of its boxes is for, which its layout's styles place
 * it by, which of them are off it, which they hide, and what goes in each
 * empty part of the others, and holds a place under its body for what the
 * stage puts there. Its boxes are drawn where they were placed by hand, if
 * they were, and while one of them is dragged, where the drag has them, until
 * the drag ends. A caret never stays in a box off its slide
 * (`selectionOutOfRemovedBox`).
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
 * `onAddImage` is asked for an image for the empty image box, starting at
 * `boxPos`, of a slide laid out with an image, with the file dropped there if
 * one was.
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
				keepSlidesFitting,
				boxFrames,
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
					// It moves only a selection in a box off its slide, never into one, and changes nothing in the
					// deck, only where this person's selection is, so it settles at once and sends the others nothing.
					appendTransaction: (transactions, _before, state) =>
						transactions.some(({ docChanged, selectionSet }) => docChanged || selectionSet)
							? (selectionOutOfRemovedBox(state) ?? null)
							: null,
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
	const boxes = boxesOf(slide).flatMap((box) => {
		const at = pos + box.startInSlide;
		const attributes = drawnBoxAttributes(box);
		const drawn =
			Object.keys(attributes).length > 0
				? [Decoration.node(at, at + box.node.nodeSize, attributes)]
				: [];
		if (!box.role || box.offSlide) return drawn;
		return [
			...drawn,
			...emptyPartsOf(box.node, at, box.role).map(({ node, at: partStart, words }) =>
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
		];
	});
	return [
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

/** The element the editor draws the body of the slide starting at `slidePos` as, if it draws it. */
export function drawnSlideBody(view: EditorView, slidePos: SlidePos): HTMLElement | undefined {
	const drawn = view.nodeDOM(slidePos);
	const body =
		drawn instanceof HTMLElement ? drawn.querySelector(":scope > [data-slide-body]") : null;
	return body instanceof HTMLElement ? body : undefined;
}

/** A slide of the deck: where it starts now, and the slide itself, followed through anybody's changes. */
interface FollowedSlide {
	pos: number;
	followed: FollowedNode;
}

/** Where a drag has the boxes of `slide`, before it is written. */
interface BoxesPreview {
	slide: FollowedSlide;
	frames: readonly Frame[];
}

const boxesPreviewKey = new PluginKey<BoxesPreview | null>("boxesPreview");

/**
 * Draws the boxes of `slide` at `frames`, as one of them is dragged, until
 * the drag ends with `withoutBoxesPreview`. It changes nothing in the deck,
 * for anybody: the slide is only drawn placed here, so a drag is written
 * once, when it ends.
 */
export const previewingBoxes = (
	state: EditorState,
	slide: FollowedSlide,
	frames: readonly Frame[],
): Transaction => state.tr.setMeta(boxesPreviewKey, { slide, frames });

/** `transaction`, ending the drawing of a drag's boxes (see `previewingBoxes`) as it is made. */
export const withoutBoxesPreview = (transaction: Transaction): Transaction =>
	transaction.setMeta(boxesPreviewKey, null);

/**
 * Drawing each box of the slide in view at its frame, as the placed slide's
 * styles draw it (see `app.css`): where the slide's boxes were placed by hand,
 * or, for the slide one of whose boxes is being dragged, where the drag has
 * them. Only the slide in view is drawn, so only its boxes need their frames.
 *
 * The slide a drag is on is followed through anybody's changes as the drag
 * goes on, and its drawing ends once the slide is gone. A change made here
 * moves it step by step; a change from elsewhere, or an undo, replaces each
 * slide it touches whole, which reads as the slide's deletion, so the slide is
 * then looked for where the shared document has it.
 */
const boxFrames = new Plugin<BoxesPreview | null>({
	key: boxesPreviewKey,
	state: {
		init: () => null,
		apply(transaction, preview, _before, state) {
			const said: BoxesPreview | null | undefined = transaction.getMeta(boxesPreviewKey);
			if (said !== undefined) return said;
			if (!preview || !transaction.docChanged) return preview;
			const { followed } = preview.slide;
			const mapped = transaction.mapping.mapResult(preview.slide.pos, 1);
			const pos = mapped.deleted ? whereFollowedNodeIs(state.doc, followed) : mapped.pos;
			return pos === undefined ? null : { ...preview, slide: { pos, followed } };
		},
	},
	props: {
		decorations(state) {
			const preview = boxesPreviewKey.getState(state);
			const previewed = preview ? previewDecorations(state.doc, preview) : [];
			const inView = slidesOf(state.doc)[slideInView(state)];
			const previewedInView = previewed.length > 0 && preview?.slide.pos === inView?.pos;
			const placed = inView && !previewedInView ? placedBoxDecorations(inView) : [];
			const decorations = [...previewed, ...placed];
			return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
		},
	},
});

/** Each box of `slide` at the frame it was placed at, when its boxes were placed by hand. */
function placedBoxDecorations({ node: slide, pos }: SlideAt): Decoration[] {
	const placement = placementOf(slide);
	if (!placement) return [];
	return boxesOf(slide).flatMap(({ node: box, index, startInSlide }) => {
		const frame = placement[index];
		const at = pos + startInSlide;
		return frame ? [Decoration.node(at, at + box.nodeSize, { style: frameStyle(frame) })] : [];
	});
}

/**
 * The slide `preview` is of, drawn placed, and each of its boxes at the
 * drag's frame for it. Nothing once the slide no longer holds a box for each
 * of the drag's frames.
 */
function previewDecorations(
	deck: Node,
	{ slide: { pos: slidePos }, frames }: BoxesPreview,
): Decoration[] {
	const slide = deck.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE) return [];
	const boxes = boxesOf(slide);
	if (boxes.length !== frames.length) return [];
	const decorations = placementOf(slide)
		? []
		: [Decoration.node(slidePos, slidePos + slide.nodeSize, { [PLACEMENT_ATTRIBUTE]: "" })];
	for (const { node: box, index, startInSlide } of boxes) {
		const frame = frames[index];
		const at = slidePos + startInSlide;
		if (frame) {
			decorations.push(Decoration.node(at, at + box.nodeSize, { style: frameStyle(frame) }));
		}
	}
	return decorations;
}

/** The inline style a box is drawn at `frame` by (`boxFrameProperties`). */
const frameStyle = (frame: Frame) =>
	Object.entries(boxFrameProperties(frame))
		.map(([name, value]) => `${name}: ${value}`)
		.join("; ");

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

/**
 * The empty parts of a slide's box of `role`, which starts at `start`, with
 * what goes in each: in the image's box, while it holds only an empty line,
 * the image; in any other, on each empty line but those in a table or code,
 * what the box is for, a heading on a heading, and a quote in a quote. In the
 * title's box, the heading it starts with is the title, and a line under it
 * the subtitle.
 */
function emptyPartsOf(box: Node, start: number, role: BoxRole): EmptyPart[] {
	if (role === "image" && holdsOnlyAnEmptyParagraph(box)) {
		return [{ node: box, at: start, words: ADD_IMAGE }];
	}
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
function lineWords(line: Node, parent: Node | null, role: BoxRole, titled: boolean): string {
	if (line.type.name === "heading")
		return role === "title" && !titled ? "Add a title" : "Add a heading";
	if (parent?.type.name === "blockquote") return "Add a quote";
	if (role === "title" && titled) return "Add a subtitle";
	return EMPTY_LINE_WORDS[role];
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
