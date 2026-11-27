import {
	isSuggestChangesEnabled,
	revertSuggestions,
} from "@handlewithcare/prosemirror-suggest-changes";
import {
	holdsSuggestion,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	SUGGESTED_MODIFICATION,
} from "@sugabots/contracts/live-document";
import {
	bodyOf,
	boxAttributesOf,
	FIRST_BOX_IN_SLIDE,
	laidOutAnew,
	layoutOf,
	newBox,
	newSlide,
	resetToTemplate,
	SLIDE,
	SLIDE_BODY,
	SLIDE_BOX,
	setBoxAttributes,
} from "@sugabots/contracts/live-slides";
import type { BoxAttributes } from "@sugabots/contracts/slide-box";
import {
	type Frame,
	SLIDE_HEIGHT,
	SLIDE_UNIT,
	SLIDE_WIDTH,
} from "@sugabots/contracts/slide-geometry";
import type { SlideLayout } from "@sugabots/contracts/slide-layouts";
import { changedPath, type SvgPath } from "@sugabots/contracts/svg-path";
import type { Node, NodeType, Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { sameFrame } from "./box-frames.ts";
import { type FollowedNode, whereFollowedNodeIs } from "./followed-node.ts";
import { madeAsItIs } from "./suggesting.ts";

/*
 * A `slides` deck being edited: its slides, and the changes made to them
 * whole, from the strip of slides and the stage. Each change is one
 * transaction, which suggesting mode turns into one suggestion.
 *
 * A slide is known by where it starts in the deck (`SlidePos`) or by its
 * place among the slides (`SlideIndex`), and a box by its place among its
 * slide's boxes (`BoxIndex`) or by where it starts (`BoxPos`): each a number
 * of its own type, so one given where another is asked for doesn't compile.
 */

declare const slidePosBrand: unique symbol;
declare const slideIndexBrand: unique symbol;
declare const boxIndexBrand: unique symbol;
declare const boxPosBrand: unique symbol;

/** Where a slide starts in its deck's document. */
export type SlidePos = number & { readonly [slidePosBrand]: true };

/** A slide's place among its deck's slides, from 0. */
export type SlideIndex = number & { readonly [slideIndexBrand]: true };

/** A box's place among the boxes of its slide's body, from 0. */
export type BoxIndex = number & { readonly [boxIndexBrand]: true };

/** Where a box starts in its deck's document. */
export type BoxPos = number & { readonly [boxPosBrand]: true };

/** What each layout is called, in the layout picker and in a suggestion's card. */
export const LAYOUT_NAMES: Record<SlideLayout, string> = {
	title: "Title",
	bullets: "Title and bullets",
	columns: "Two columns",
	image: "Image and text",
	section: "Section break",
	quote: "Quote",
	table: "Table",
	blank: "Blank",
};

/** A slide of a deck: the node, where it starts, and its place among the slides. */
export interface SlideAt {
	node: Node;
	pos: SlidePos;
	index: SlideIndex;
}

export function slidesOf(deck: Node): SlideAt[] {
	const slides: SlideAt[] = [];
	deck.forEach((node, pos, index) => {
		slides.push({ node, pos: pos as SlidePos, index: index as SlideIndex });
	});
	return slides;
}

/** The index of the slide holding `pos`, or of the slide after it when it falls between two. */
export function slideIndexAt(deck: Node, pos: number): SlideIndex {
	return Math.min(deck.resolve(pos).index(0), deck.childCount - 1) as SlideIndex;
}

/**
 * `index`, a slide's place as a list of `deck`'s slides numbers it from 0, as
 * that slide's index: `undefined` when `deck` has no slide there.
 */
export const slideIndexIn = (deck: Node, index: number): SlideIndex | undefined =>
	Number.isInteger(index) && index >= 0 && index < deck.childCount
		? (index as SlideIndex)
		: undefined;

/**
 * Where the slide `followed` (see `followNode`) starts in `deck`, or
 * `undefined` once it is gone, or when what `followed` follows is no slide.
 */
export function whereFollowedSlideIs(deck: Node, followed: FollowedNode): SlidePos | undefined {
	const pos = whereFollowedNodeIs(deck, followed);
	if (pos === undefined || deck.nodeAt(pos)?.type.name !== SLIDE) return undefined;
	return pos as SlidePos;
}

/**
 * Where the box `followed` (see `followNode`) starts in `deck`, or
 * `undefined` once it is gone, or when what `followed` follows is no box.
 */
export function whereFollowedBoxIs(deck: Node, followed: FollowedNode): BoxPos | undefined {
	const pos = whereFollowedNodeIs(deck, followed);
	if (pos === undefined || deck.nodeAt(pos)?.type.name !== SLIDE_BOX) return undefined;
	return pos as BoxPos;
}

/**
 * Where the box `followed` (see `followNode`) is in `deck`: where it starts,
 * where its slide starts, and its place among that slide's boxes.
 * `undefined` once it is gone.
 */
export function placeOfFollowedBox(
	deck: Node,
	followed: FollowedNode,
): { boxPos: BoxPos; slidePos: SlidePos; box: BoxIndex } | undefined {
	const boxPos = whereFollowedBoxIs(deck, followed);
	if (boxPos === undefined) return undefined;
	// A deck holds slides, which hold their body, which holds the boxes.
	const place = deck.resolve(boxPos);
	return { boxPos, slidePos: place.before(1) as SlidePos, box: place.index(2) as BoxIndex };
}

/** The index of the box on the slide at `slideIndex` that holds `pos`, if one does. */
export function boxHolding(deck: Node, pos: number, slideIndex: SlideIndex): BoxIndex | undefined {
	const place = deck.resolve(pos);
	// A deck holds slides, which hold their body, which holds the boxes.
	if (place.depth < 3 || place.index(0) !== slideIndex) return undefined;
	return place.node(2).type.name === SLIDE_BODY ? (place.index(2) as BoxIndex) : undefined;
}

/** `index`, a place among `slide`'s boxes, as that box's index: `undefined` when its body holds no box there. */
export const boxIndexIn = (slide: Node, index: number): BoxIndex | undefined =>
	Number.isInteger(index) && index >= 0 && index < bodyOf(slide).childCount
		? (index as BoxIndex)
		: undefined;

/** One of the boxes a slide's body holds, as the stage and a drawing of the slide treat it. */
export interface BoxOfSlide {
	node: Node;
	index: BoxIndex;
	/** Where it starts, counted from where its slide starts. */
	startInSlide: number;
	/** How it is drawn: where, what it is for, and how it is painted. */
	attributes: BoxAttributes;
}

/** The boxes `slide`'s body holds, in the order they are drawn, each over those before it. */
export function boxesOf(slide: Node): BoxOfSlide[] {
	const boxes: BoxOfSlide[] = [];
	bodyOf(slide).forEach((node, offset, index) => {
		boxes.push({
			node,
			index: index as BoxIndex,
			startInSlide: FIRST_BOX_IN_SLIDE + offset,
			attributes: boxAttributesOf(node),
		});
	});
	return boxes;
}

/** Where `slide`'s notes start, counted from where the slide starts: past its own start and its body. */
export const notesStartInSlide = (slide: Node): number => 1 + bodyOf(slide).nodeSize;

/** Whether somebody proposes adding the slide, or removing it. */
export function proposedChangeOf(slide: Node): "adding" | "removing" | undefined {
	if (slide.marks.some((mark) => mark.type.name === SUGGESTED_INSERTION)) return "adding";
	if (slide.marks.some((mark) => mark.type.name === SUGGESTED_DELETION)) return "removing";
	return undefined;
}

function nodeType(schema: Schema, name: string): NodeType {
	const type = schema.nodes[name];
	if (!type) throw new Error(`The schema has no ${name} node`);
	return type;
}

/** Where the first box of the slide starting at `slidePos` starts. */
const firstBoxPos = (slidePos: number) => slidePos + FIRST_BOX_IN_SLIDE;

/** Adds a new slide of `layout` after the slide at `after`, with the caret at its start. */
export function addSlide(state: EditorState, after: SlideIndex, layout: SlideLayout): Transaction {
	const previous = slidesOf(state.doc)[after];
	const at = previous ? previous.pos + previous.node.nodeSize : state.doc.content.size;
	const adding = state.tr.insert(at, newSlide(state.schema, layout));
	return adding
		.setSelection(TextSelection.near(adding.doc.resolve(firstBoxPos(at))))
		.scrollIntoView();
}

/**
 * Puts the caret at the start of the slide at `index`: in its first box, or
 * in its notes when it has no box.
 */
export function selectSlide(state: EditorState, index: SlideIndex): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide) return undefined;
	return state.tr.setSelection(TextSelection.near(state.doc.resolve(firstBoxPos(slide.pos))));
}

/**
 * Lays the slide at `index` out by `layout`, as a bot's change of its layout
 * lays it out too (`laidOutAnew`): its boxes of the roles the new layout
 * places go where its template places them, what they hold moved by what each
 * is for, losing nothing, and every box it places but the slide lacks added.
 * A box that holds what it held keeps its node, and is only drawn anew, so
 * somebody typing in it keeps what they type. `undefined` when the slide has
 * that layout already, or when a suggestion waits in it (see
 * `holdsSuggestion`): a suggestion in a box that changes would be lost.
 */
export function changeLayout(
	state: EditorState,
	index: SlideIndex,
	layout: SlideLayout,
): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide || layoutOf(slide.node) === layout || holdsSuggestion(slide.node)) return undefined;
	const laidOut = laidOutAnew(slide.node, layout);
	// The attribute first, as the API's change does: setting it moves nothing still to be replaced.
	const changing = state.tr.setNodeAttribute(slide.pos, "layout", layout);
	return rearrangeBoxes(changing, slide.pos, bodyOf(laidOut).children);
}

/**
 * Whether `slide`'s boxes of the roles its layout places have moved from
 * where its template places them, or are drawn otherwise, which resetting its
 * layout (`resetLayout`) puts back.
 */
export const canResetLayout = (slide: Node): boolean => resetToTemplate(slide) !== slide;

/**
 * Puts each box of the slide at `index` of a role its layout places back
 * where its template places it (`resetToTemplate`), every other box, and what
 * each holds, as it is. Where a box sits is never a suggestion, so it is made
 * at once, even while the person is suggesting. `undefined` when every such
 * box is there already (`canResetLayout`).
 */
export function resetLayout(state: EditorState, index: SlideIndex): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide) return undefined;
	const reset = resetToTemplate(slide.node);
	if (reset === slide.node) return undefined;
	return madeAsItIs(rearrangeBoxes(state.tr, slide.pos, bodyOf(reset).children));
}

/**
 * `transaction` with the boxes of the slide starting at `slidePos` made into
 * `boxes`, changing as little as it can: each box that holds what one of
 * `boxes` holds, in order, is kept, and given that box's attributes where
 * they differ; the others there are deleted, and the others of `boxes`
 * added where they go.
 */
function rearrangeBoxes(
	transaction: Transaction,
	slidePos: number,
	boxes: readonly Node[],
): Transaction {
	const slide = transaction.doc.nodeAt(slidePos);
	if (!slide) return transaction;
	const was = bodyOf(slide).children;
	const kept = keptInOrder(was, boxes);
	let at = firstBoxPos(slidePos);
	let [from, to] = [0, 0];
	while (from < was.length || to < boxes.length) {
		const before = was[from];
		const after = boxes[to];
		if (before && after && kept.get(from) === to) {
			setBoxAttributes(transaction, at, changedAttributes(before, after));
			at += after.nodeSize;
			from++;
			to++;
		} else if (before && !kept.has(from)) {
			transaction.delete(at, at + before.nodeSize);
			from++;
		} else if (after) {
			transaction.insert(at, after);
			at += after.nodeSize;
			to++;
		}
	}
	return transaction;
}

/**
 * Which of the boxes `was` are kept as which of `becomes`, by their places:
 * the most of them that hold the same, in the same order.
 */
function keptInOrder(was: readonly Node[], becomes: readonly Node[]): Map<number, number> {
	const holdsSame = (from: number, to: number) => {
		const [one, other] = [was[from], becomes[to]];
		return one !== undefined && other !== undefined && one.content.eq(other.content);
	};
	// How many can be kept of the boxes from each place in either on, by `from * width + to`.
	const width = becomes.length + 1;
	const most = new Array<number>((was.length + 1) * width).fill(0);
	const mostFrom = (from: number, to: number) => most[from * width + to] ?? 0;
	for (let from = was.length - 1; from >= 0; from--) {
		for (let to = becomes.length - 1; to >= 0; to--) {
			most[from * width + to] = holdsSame(from, to)
				? mostFrom(from + 1, to + 1) + 1
				: Math.max(mostFrom(from + 1, to), mostFrom(from, to + 1));
		}
	}
	const kept = new Map<number, number>();
	let [from, to] = [0, 0];
	while (from < was.length && to < becomes.length) {
		if (holdsSame(from, to)) kept.set(from++, to++);
		else if (mostFrom(from + 1, to) >= mostFrom(from, to + 1)) from++;
		else to++;
	}
	return kept;
}

/** The attributes `after` is drawn with that `before` isn't. */
function changedAttributes(before: Node, after: Node): Partial<BoxAttributes> {
	const was = boxAttributesOf(before);
	const becomes = boxAttributesOf(after);
	return Object.fromEntries(
		Object.entries(becomes).filter(
			([name, value]) => JSON.stringify(value) !== JSON.stringify(was[name as keyof BoxAttributes]),
		),
	) as Partial<BoxAttributes>;
}

/**
 * Moves the slide at `from` so it stands at `to` among the slides, after the
 * slide now there when it moves later and before it when it moves earlier,
 * keeping the caret in it. `undefined` when either isn't a slide's place, or
 * when they are the same.
 */
export function moveSlideTo(
	state: EditorState,
	from: SlideIndex,
	to: SlideIndex,
): Transaction | undefined {
	const slides = slidesOf(state.doc);
	const [moving, there] = [slides[from], slides[to]];
	if (!moving || !there || from === to) return undefined;
	const { node, pos } = moving;
	const moved = state.tr;
	// The step at the later place goes first, so the earlier place hasn't moved for the second.
	if (to > from) {
		moved.insert(there.pos + there.node.nodeSize, node).delete(pos, pos + node.nodeSize);
	} else {
		moved.delete(pos, pos + node.nodeSize).insert(there.pos, node);
	}
	const movedTo = to > from ? there.pos + there.node.nodeSize - node.nodeSize : there.pos;
	return moved.setSelection(TextSelection.near(moved.doc.resolve(firstBoxPos(movedTo))));
}

/**
 * Where the slide `moveSlideTo` moved from `from` to `to` stands in `after`,
 * the deck the move made of `before`. Made as a suggestion, the move leaves
 * the slide where it was too, proposed for removal until the move is
 * accepted, so a slide moved later stands one place further on.
 */
export function placeOfMovedSlide(
	before: Node,
	after: Node,
	from: SlideIndex,
	to: SlideIndex,
): SlideIndex {
	const keptWhereItWas = after.childCount - before.childCount;
	return (to > from ? to + keptWhereItWas : to) as SlideIndex;
}

/** Removes the slide at `index`. `undefined` for a deck's last slide, which a deck can't be without. */
export function removeSlide(state: EditorState, index: SlideIndex): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide || state.doc.childCount <= 1) return undefined;
	return state.tr.delete(slide.pos, slide.pos + slide.node.nodeSize);
}

/**
 * Puts the image `src`, its words `alt`, in the box that starts at `boxPos`:
 * on its empty line, or on a line of its own after what it holds. `undefined`
 * when no box starts there any more.
 */
export function addImage(
	state: EditorState,
	boxPos: BoxPos,
	{ src, alt }: { src: string; alt: string },
): Transaction | undefined {
	const box = state.doc.nodeAt(boxPos);
	if (box?.type.name !== SLIDE_BOX) return undefined;
	const image = nodeType(state.schema, "image").create({ src, alt });
	const first = box.firstChild;
	if (first?.type.name === "paragraph" && first.content.size === 0) {
		return state.tr.insert(inside(boxPos), image);
	}
	const end = boxPos + box.nodeSize - 1;
	return state.tr.insert(end, nodeType(state.schema, "paragraph").create(null, image));
}

/** Where what the first child of a node starting at `pos` holds starts: past the node's own start and that child's. */
const inside = (pos: number) => pos + 2;

/**
 * Whether the slide's boxes wait on a suggestion: a new layout for it, or a
 * box somebody proposes adding or removing, as a new layout does. Until it is
 * settled, a box moved by hand could be moved again by settling it.
 */
export function boxesWaitOnSuggestion(slide: Node): boolean {
	const newLayout = slide.marks.some(
		(mark) => mark.type.name === SUGGESTED_MODIFICATION && mark.attrs.attrName === "layout",
	);
	return (
		newLayout ||
		bodyOf(slide).children.some((box) =>
			box.marks.some(
				(mark) => mark.type.name === SUGGESTED_INSERTION || mark.type.name === SUGGESTED_DELETION,
			),
		)
	);
}

/**
 * Places the box at `box`, on the slide starting at `slidePos`, at `frame`,
 * its shape, if it is one, stretched with it. `undefined` when no slide
 * starts there, when its boxes wait on a suggestion (see
 * `boxesWaitOnSuggestion`), when it has no such box, or when the box is at
 * `frame` already.
 *
 * Where a box sits is never a suggestion, so it is placed at once, even while
 * the person is suggesting.
 */
export function placeBox(
	state: EditorState,
	slidePos: SlidePos,
	box: BoxIndex,
	frame: Frame,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE || boxesWaitOnSuggestion(slide)) return undefined;
	const placed = boxesOf(slide)[box];
	if (!placed || sameFrame(placed.attributes.frame, frame)) return undefined;
	const { path, frame: was } = placed.attributes;
	const stretched = path ? { path: pathStretched(path, was, frame) } : {};
	return madeAsItIs(
		setBoxAttributes(state.tr, slidePos + placed.startInSlide, { frame, ...stretched }),
	);
}

/**
 * `path`, a shape's in a box framed at `was`, stretched to fill the box
 * framed at `becomes` as it filled it before. Across a size of nothing, as
 * a line's height may be, it is left as it is: it has no size to stretch.
 */
function pathStretched(path: SvgPath, was: Frame, becomes: Frame): SvgPath {
	const scale = (before: number, after: number) => (before === 0 ? 1 : after / before);
	const scaleX = scale(was.width, becomes.width);
	const scaleY = scale(was.height, becomes.height);
	if (scaleX === 1 && scaleY === 1) return path;
	return changedPath(path, { scaleX, scaleY, moveX: 0, moveY: 0 });
}

/**
 * Why a box can't be deleted now: the person is suggesting, and a deletion
 * is made at once, never as a suggestion, as where a box sits is; or a
 * suggestion waits in the box, which deleting what it holds would lose.
 */
export type BoxRemovalBlocked = "suggesting" | "suggestionPending";

export function boxRemovalBlocked(state: EditorState, box: Node): BoxRemovalBlocked | undefined {
	if (isSuggestChangesEnabled(state)) return "suggesting";
	if (holdsSuggestion(box)) return "suggestionPending";
	return undefined;
}

/** Why a box can't be deleted now, as the person is told it. */
export const BOX_REMOVAL_BLOCKED_WORDS: Record<BoxRemovalBlocked, string> = {
	suggesting: "Turn off Suggesting to delete a box.",
	suggestionPending: "Accept or undo the suggestions in this box to delete it.",
};

/**
 * Deletes the box at `box` from the slide starting at `slidePos`, for
 * everybody, with what it holds: one change, which one undo brings back
 * whole. The caret goes to the start of the nearest box left on the slide,
 * the next or else the one before, or else to its notes.
 *
 * Like placing a box, it is never a suggestion. `undefined` when no slide
 * starts there, when its boxes wait on a suggestion (`boxesWaitOnSuggestion`),
 * when it has no such box, or when `boxRemovalBlocked` says why the box can't
 * be deleted.
 */
export function removeBox(
	state: EditorState,
	slidePos: SlidePos,
	box: BoxIndex,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE || boxesWaitOnSuggestion(slide)) return undefined;
	const removed = boxesOf(slide)[box];
	if (!removed || boxRemovalBlocked(state, removed.node)) return undefined;
	const boxPos = slidePos + removed.startInSlide;
	const removing = state.tr.delete(boxPos, boxPos + removed.node.nodeSize);
	const left = removing.doc.nodeAt(slidePos);
	if (!left) return madeAsItIs(removing);
	const boxesLeft = boxesOf(left);
	const nearest = boxesLeft[box] ?? boxesLeft[box - 1];
	const caretFrom = slidePos + (nearest?.startInSlide ?? notesStartInSlide(left));
	return madeAsItIs(removing.setSelection(TextSelection.near(removing.doc.resolve(caretFrom + 1))));
}

/** How big a text box added by hand is: room for a line of a few words. */
const NEW_TEXT_BOX = { width: 20 * SLIDE_UNIT, height: 3 * SLIDE_UNIT } as const;

/**
 * Adds an empty text box, for nothing in particular, to the slide starting
 * at `slidePos`, over its other boxes, with the caret in it: its top left
 * corner at `at`, a point on the slide in its pixels, kept on the slide, or
 * in the slide's middle without one. Like placing a box, it is made at once,
 * even while the person is suggesting: it holds no words until they type
 * them. `undefined` when no slide starts there.
 */
export function addTextBox(
	state: EditorState,
	slidePos: SlidePos,
	at: { x: number; y: number } | undefined,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE) return undefined;
	const { width, height } = NEW_TEXT_BOX;
	const corner = at ?? { x: (SLIDE_WIDTH - width) / 2, y: (SLIDE_HEIGHT - height) / 2 };
	const frame = {
		x: Math.round(Math.min(Math.max(corner.x, 0), SLIDE_WIDTH - width)),
		y: Math.round(Math.min(Math.max(corner.y, 0), SLIDE_HEIGHT - height)),
		width,
		height,
	};
	const box = newBox(state.schema, { frame }, []);
	// The end of the slide's body, past the slide's own start and the boxes it holds.
	const end = slidePos + 1 + bodyOf(slide).nodeSize - 1;
	const adding = state.tr.insert(end, box);
	return madeAsItIs(adding.setSelection(TextSelection.create(adding.doc, inside(end))));
}

/**
 * The deck as it reads with every suggestion in it left out, as it reads
 * until somebody accepts one: what somebody proposes adding is not in it, and
 * what they propose removing still is.
 */
export function asItReadsNow(deck: Node): Node {
	let reverted = deck;
	revertSuggestions(EditorState.create({ doc: deck }), (transaction) => {
		reverted = transaction.doc;
	});
	return reverted;
}
