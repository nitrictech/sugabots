import {
	isSuggestChangesEnabled,
	revertSuggestions,
} from "@handlewithcare/prosemirror-suggest-changes";
import {
	holdsSuggestion,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
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
import type { Node } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { sameFrame } from "./box-frames.ts";
import { type FollowedNode, whereFollowedNodeIs } from "./followed-node.ts";
import { nodeOf } from "./schema-nodes.ts";
import { madeAsItIs } from "./suggesting.ts";
import { suggestedAttributesOf } from "./suggestions.ts";

/*
 * A `slides` deck being edited: its slides, and the changes made to them
 * whole, from the strip of slides and the stage. Each change is one
 * transaction. Suggesting mode turns a change to what a deck says into one
 * suggestion; a change to where its boxes sit, or adding or deleting a box,
 * is made at once, for everybody, never as a suggestion (`madeAsItIs`).
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
 * Whether resetting `slide`'s layout (`resetLayout`) would change anything:
 * whether its boxes of the roles its layout places have moved from where its
 * template places them, or are drawn otherwise, and none of what it would
 * change of them waits on a suggestion.
 */
export const canResetLayout = (slide: Node): boolean => slideReset(slide) !== undefined;

/**
 * Puts each box of the slide at `index` of a role its layout places back
 * where its template places it (`resetToTemplate`), every other box, and what
 * each holds, as it is. Where a box sits is never a suggestion, so it is made
 * at once, even while the person is suggesting. `undefined` when resetting
 * would change nothing (`canResetLayout`).
 */
export function resetLayout(state: EditorState, index: SlideIndex): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	const reset = slide && slideReset(slide.node);
	if (!slide || !reset) return undefined;
	return madeAsItIs(rearrangeBoxes(state.tr, slide.pos, bodyOf(reset).children));
}

/**
 * `slide` with its layout reset (`resetToTemplate`): `undefined` when that
 * changes nothing, or would change an attribute of one of its boxes that a
 * suggestion waits to change, which rejecting it would put back.
 */
function slideReset(slide: Node): Node | undefined {
	const reset = resetToTemplate(slide);
	if (reset === slide) return undefined;
	const boxes = bodyOf(slide).children;
	const overwritesSuggestion = bodyOf(reset).children.some((after, index) => {
		const before = boxes[index];
		if (!before) return false;
		const suggested = suggestedAttributesOf(before);
		return Object.keys(changedAttributes(before, after)).some((name) => suggested.has(name));
	});
	return overwritesSuggestion ? undefined : reset;
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
	const image = nodeOf(state.schema, "image", undefined, { src, alt });
	const first = box.firstChild;
	if (first?.type.name === "paragraph" && first.content.size === 0) {
		return state.tr.insert(inside(boxPos), image);
	}
	const end = boxPos + box.nodeSize - 1;
	return state.tr.insert(end, nodeOf(state.schema, "paragraph", image));
}

/** Where what the first child of a node starting at `pos` holds starts: past the node's own start and that child's. */
const inside = (pos: number) => pos + 2;

/** The attributes of a box that setting its frame writes: its frame, and a shape's outline, stretched with it. */
const FRAMING_WRITES: readonly (keyof BoxAttributes)[] = ["frame", "path"];

/**
 * Whether a suggestion waiting on `box` would move, resize or reshape it,
 * which keeps it where it is until somebody accepts or rejects it: rejecting
 * the suggestion puts back the frame and outline it replaced, which would
 * undo a move made in the meantime. A suggestion of anything else, on it or
 * on another box, holds nothing up.
 */
export function frameWaitsOnSuggestion(box: Node): boolean {
	const suggested = suggestedAttributesOf(box);
	return FRAMING_WRITES.some((name) => suggested.has(name));
}

/** Why a box can't be moved or resized now (see `frameWaitsOnSuggestion`), as the person is told it. */
export const BOX_FRAME_BLOCKED_WORDS =
	"Accept or undo the suggestion on this box to move or resize it.";

/**
 * Sets the frame of the box at `box`, on the slide starting at `slidePos`, to
 * `frame`, its shape, if it is one, stretched with it, and the columns of a
 * table in it made as much wider or narrower as it is. `undefined` when no
 * slide starts there, when it has no such box, when a suggestion waits to
 * move, resize or reshape the box (`frameWaitsOnSuggestion`), or when the box
 * is at `frame` already.
 *
 * Where a box sits is never a suggestion, so it is set at once, even while
 * the person is suggesting.
 */
export function setBoxFrame(
	state: EditorState,
	slidePos: SlidePos,
	box: BoxIndex,
	frame: Frame,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE) return undefined;
	const placed = boxesOf(slide)[box];
	if (!placed || frameWaitsOnSuggestion(placed.node)) return undefined;
	const was = placed.attributes.frame;
	if (sameFrame(was, frame)) return undefined;
	const boxPos = slidePos + placed.startInSlide;
	// Its shape's path is stretched with it (`withFrame`).
	const framing = setBoxAttributes(state.tr, boxPos, { frame });
	return madeAsItIs(
		columnsStretched(framing, boxPos, placed.node, scaleOf(was.width, frame.width)),
	);
}

/** How much a side `before` long is stretched to be `after` long: not at all from a length of nothing. */
const scaleOf = (before: number, after: number) => (before === 0 ? 1 : after / before);

/**
 * `transaction` with the columns of each table in `box`, which starts at
 * `boxPos`, made `scale` times as wide, as its box is. A table whose columns
 * are given widths, as one from a PowerPoint file, is drawn that wide
 * whatever its box's width, so it follows its box only so.
 */
function columnsStretched(
	transaction: Transaction,
	boxPos: number,
	box: Node,
	scale: number,
): Transaction {
	if (scale === 1) return transaction;
	box.descendants((node, offset) => {
		const widths: unknown = node.attrs.colwidth;
		if (!Array.isArray(widths)) return true;
		const stretched = widths.map((width) =>
			typeof width === "number" ? Math.max(1, Math.round(width * scale)) : width,
		);
		transaction.setNodeAttribute(boxPos + 1 + offset, "colwidth", stretched);
		return false;
	});
	return transaction;
}

/**
 * Why a box can't be deleted now: the person is suggesting, and a deletion
 * is made at once, never as a suggestion, as where a box sits is, so a box
 * showing anything can't be deleted then; or a suggestion waits in the box,
 * which deleting what it holds would lose.
 */
export type BoxDeletionBlocked = "suggesting" | "suggestionPending";

export function boxDeletionBlocked(state: EditorState, box: Node): BoxDeletionBlocked | undefined {
	if (holdsSuggestion(box)) return "suggestionPending";
	if (isSuggestChangesEnabled(state) && !showsNothing(box)) return "suggesting";
	return undefined;
}

/**
 * Whether `box` shows nothing: an empty line alone, and no fill, outline or
 * shape, as a text box added and left empty, which is added at once even
 * while the person is suggesting (`addTextBox`), and so can be deleted then.
 */
function showsNothing(box: Node): boolean {
	const { fill, stroke, path } = boxAttributesOf(box);
	const [line] = box.children;
	return (
		!fill &&
		!stroke &&
		!path &&
		box.childCount === 1 &&
		line?.type.name === "paragraph" &&
		line.content.size === 0
	);
}

/** Why a box can't be deleted now, as the person is told it. */
export const BOX_DELETION_BLOCKED_WORDS: Record<BoxDeletionBlocked, string> = {
	suggesting: "Turn off Suggesting to delete a box.",
	suggestionPending: "Accept or undo the suggestions in this box to delete it.",
};

/**
 * Deletes the box at `box` from the slide starting at `slidePos`, for
 * everybody, with what it holds: one change, which one undo brings back
 * whole. The caret goes to the start of the nearest box left on the slide,
 * the next or else the one before, or else to its notes.
 *
 * Like setting a box's frame, it is never a suggestion. `undefined` when no
 * slide starts there, when it has no such box, or when `boxDeletionBlocked`
 * says why the box can't be deleted.
 */
export function deleteBox(
	state: EditorState,
	slidePos: SlidePos,
	box: BoxIndex,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE) return undefined;
	const deleted = boxesOf(slide)[box];
	if (!deleted || boxDeletionBlocked(state, deleted.node)) return undefined;
	const boxPos = slidePos + deleted.startInSlide;
	const deleting = state.tr.delete(boxPos, boxPos + deleted.node.nodeSize);
	const left = deleting.doc.nodeAt(slidePos);
	if (!left) return madeAsItIs(deleting);
	const boxesLeft = boxesOf(left);
	const nearest = boxesLeft[box] ?? boxesLeft[box - 1];
	const caretFrom = slidePos + (nearest?.startInSlide ?? notesStartInSlide(left));
	return madeAsItIs(deleting.setSelection(TextSelection.near(deleting.doc.resolve(caretFrom + 1))));
}

declare const slidePointBrand: unique symbol;

/** A point on a slide, in its pixels from its top left corner, as against a point in the window. */
export type SlidePoint = { readonly x: number; readonly y: number } & {
	readonly [slidePointBrand]: true;
};

/** The point `x` across and `y` down a slide, in its pixels. */
export const slidePoint = (x: number, y: number): SlidePoint => ({ x, y }) as SlidePoint;

/** How big a text box added by hand is: room for a line of a few words. */
const NEW_TEXT_BOX = { width: 20 * SLIDE_UNIT, height: 3 * SLIDE_UNIT } as const;

/** How far down from one another text boxes added with no place said go: a box's height and a unit, so one doesn't cover the last. */
const NEW_TEXT_BOX_STEP = NEW_TEXT_BOX.height + SLIDE_UNIT;

/**
 * Adds an empty text box, for nothing in particular, to the slide starting
 * at `slidePos`, over its other boxes, with the caret in it: its top left
 * corner at `at`, kept on the slide, or, without one, in the slide's middle,
 * or a step down from a box there already. Like setting a box's
 * frame, it is made at once, even while the person is suggesting: it holds
 * no words until they type them, and so can be deleted while it holds none
 * (`boxDeletionBlocked`). `undefined` when no slide starts there.
 */
export function addTextBox(
	state: EditorState,
	slidePos: SlidePos,
	at: SlidePoint | undefined,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE) return undefined;
	const { width, height } = NEW_TEXT_BOX;
	const onSlide = ({ x, y }: { x: number; y: number }): Frame => ({
		x: Math.round(Math.min(Math.max(x, 0), SLIDE_WIDTH - width)),
		y: Math.round(Math.min(Math.max(y, 0), SLIDE_HEIGHT - height)),
		width,
		height,
	});
	const frame = at ? onSlide(at) : freeMiddleFrame(slide, onSlide);
	const box = newBox(state.schema, { frame }, []);
	// The end of the slide's body, past the slide's own start and the boxes it holds.
	const end = slidePos + 1 + bodyOf(slide).nodeSize - 1;
	const adding = state.tr.insert(end, box);
	return madeAsItIs(adding.setSelection(TextSelection.create(adding.doc, inside(end))));
}

/**
 * Where a text box added to `slide` with no place said goes: the slide's
 * middle, or the first place a step down from it, and from each box added so
 * before, where no box of `slide` has its top left corner, as far down as
 * the slide goes, and its middle again past that. `onSlide` frames a new box
 * with its corner at a point, kept on the slide.
 */
function freeMiddleFrame(slide: Node, onSlide: (corner: { x: number; y: number }) => Frame): Frame {
	const taken = new Set(boxesOf(slide).map(({ attributes: { frame } }) => `${frame.x} ${frame.y}`));
	const middle = onSlide({
		x: (SLIDE_WIDTH - NEW_TEXT_BOX.width) / 2,
		y: (SLIDE_HEIGHT - NEW_TEXT_BOX.height) / 2,
	});
	let frame = middle;
	while (taken.has(`${frame.x} ${frame.y}`)) {
		const next = onSlide({ x: frame.x, y: frame.y + NEW_TEXT_BOX_STEP });
		if (sameFrame(next, frame)) return middle;
		frame = next;
	}
	return frame;
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
