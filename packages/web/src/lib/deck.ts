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
	emptyLine,
	fitSlideBody,
	isRemovedBox,
	laidOutAnew,
	layoutOf,
	newSlide,
	PLACEMENT,
	placementOf,
	REMOVED,
	SLIDE,
	SLIDE_BODY,
	SLIDE_BOX,
} from "@sugabots/contracts/live-slides";
import {
	type Frame,
	placementIn,
	SLIDE_BOX_ROLES,
	type SlideLayout,
} from "@sugabots/contracts/slides-markdown";
import { getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Fragment, Node, NodeType, ResolvedPos, Schema } from "@tiptap/pm/model";
import {
	EditorState,
	Plugin,
	PluginKey,
	type Selection,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { sameFrame } from "./box-frames.ts";
import { neverSuggested } from "./suggesting.ts";

/*
 * A `slides` deck being edited: its slides, and the changes made to them
 * whole, from the strip of slides and the stage. Each change is one
 * transaction, which suggesting mode turns into one suggestion.
 */

/** What each layout is called, in the layout picker and in a suggestion's card. */
export const LAYOUT_NAMES: Record<SlideLayout, string> = {
	title: "Title",
	bullets: "Title and bullets",
	columns: "Two columns",
	image: "Image and text",
	section: "Section break",
	quote: "Quote",
	table: "Table",
};

/** A slide of a deck: the node, where it starts, and its place among the slides. */
export interface PlacedSlide {
	node: Node;
	pos: number;
	index: number;
}

export function slidesOf(deck: Node): PlacedSlide[] {
	const slides: PlacedSlide[] = [];
	deck.forEach((node, pos, index) => {
		slides.push({ node, pos, index });
	});
	return slides;
}

/** The index of the slide holding `pos`, or of the slide after it when it falls between two. */
export function slideIndexAt(deck: Node, pos: number): number {
	return Math.min(deck.resolve(pos).index(0), deck.childCount - 1);
}

/** The index of the box on the slide at `slideIndex` that holds `pos`, if one does. */
export function boxAt(deck: Node, pos: number, slideIndex: number): number | undefined {
	const place = deck.resolve(pos);
	// A deck holds slides, which hold their frame, which holds the boxes.
	if (place.depth < 3 || place.index(0) !== slideIndex) return undefined;
	return place.node(2).type.name === SLIDE_BODY ? place.index(2) : undefined;
}

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

/** Adds a new slide of `layout` after the slide at `after`, with the caret at its start. */
export function addSlide(state: EditorState, after: number, layout: SlideLayout): Transaction {
	const previous = slidesOf(state.doc)[after];
	const at = previous ? previous.pos + previous.node.nodeSize : state.doc.content.size;
	const adding = state.tr.insert(at, newSlide(state.schema, layout));
	return adding.setSelection(TextSelection.near(adding.doc.resolve(inside(at)))).scrollIntoView();
}

/** Where what the first child of a node starting at `pos` holds starts: past the node's own start and that child's. */
const inside = (pos: number) => pos + 2;

/**
 * Puts the caret at the start of the slide at `index`: in its first box, from
 * which a caret in a box off the slide is moved on to the first box on it
 * (`selectionOutOfRemovedBox`).
 */
export function selectSlide(state: EditorState, index: number): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide) return undefined;
	return state.tr.setSelection(TextSelection.near(state.doc.resolve(inside(slide.pos))));
}

/**
 * Lays the slide at `index` out by `layout`, as a bot's change of its layout
 * lays it out too (`laidOutAnew`): what its boxes hold moved to the new
 * layout's boxes by what each is for, losing nothing, with every box of the
 * new layout on it, any removed from it brought back, and dropping where its
 * boxes were placed by hand, as a placement is of its old layout's boxes.
 * Only the boxes that change are replaced, so somebody typing in the slide's
 * title keeps what they type. `undefined` when the slide has that layout
 * already, or when a suggestion waits in it (see `holdsSuggestion`): its
 * frame may hold two layouts' content until that is settled, and a
 * suggestion in a box that changes would be lost.
 */
export function changeLayout(
	state: EditorState,
	index: number,
	layout: SlideLayout,
): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide || layoutOf(slide.node) === layout || holdsSuggestion(slide.node)) return undefined;
	const laidOut = laidOutAnew(slide.node, layout);
	// The attributes first, as the API's change does: setting them moves nothing still to be replaced.
	const changing = state.tr.setNodeAttribute(slide.pos, "layout", layout);
	if (slide.node.attrs[PLACEMENT] !== null) changing.setNodeAttribute(slide.pos, PLACEMENT, null);
	bringBackRemovedBoxes(changing, slide.pos);
	replaceChangedChildren(
		changing,
		inside(slide.pos),
		changing.doc.child(index).child(0).content,
		laidOut.child(0).content,
	);
	return changing;
}

/**
 * Replaces the children `was`, which start at `start`, with `becomes`,
 * leaving in place the run of children at either end they have alike.
 */
function replaceChangedChildren(
	transaction: Transaction,
	start: number,
	was: Fragment,
	becomes: Fragment,
): void {
	let same = 0;
	while (
		same < was.childCount &&
		same < becomes.childCount &&
		was.child(same).eq(becomes.child(same))
	) {
		same++;
	}
	let [wasEnd, becomesEnd] = [was.childCount, becomes.childCount];
	while (
		wasEnd > same &&
		becomesEnd > same &&
		was.child(wasEnd - 1).eq(becomes.child(becomesEnd - 1))
	) {
		wasEnd--;
		becomesEnd--;
	}
	if (same === wasEnd && same === becomesEnd) return;
	const from = start + sizeOf(was, 0, same);
	transaction.replaceWith(
		from,
		from + sizeOf(was, same, wasEnd),
		becomes.cut(sizeOf(becomes, 0, same), sizeOf(becomes, 0, becomesEnd)),
	);
}

/** How much of the document the children of `fragment` from `from` up to `to` take. */
function sizeOf(fragment: Fragment, from: number, to: number): number {
	let size = 0;
	for (let index = from; index < to; index++) size += fragment.child(index).nodeSize;
	return size;
}

/**
 * Moves the slide at `from` so it stands at `to` among the slides, after the
 * slide now there when it moves later and before it when it moves earlier,
 * keeping the caret in it. `undefined` when either isn't a slide's place, or
 * when they are the same.
 */
export function moveSlideTo(state: EditorState, from: number, to: number): Transaction | undefined {
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
	return moved.setSelection(TextSelection.near(moved.doc.resolve(inside(movedTo))));
}

/**
 * Where the slide `moveSlideTo` moved from `from` to `to` stands in `after`,
 * the deck the move made of `before`. Made as a suggestion, the move leaves
 * the slide where it was too, proposed for removal until the move is
 * accepted, so a slide moved later stands one place further on.
 */
export function placeOfMovedSlide(before: Node, after: Node, from: number, to: number): number {
	const keptWhereItWas = after.childCount - before.childCount;
	return to > from ? to + keptWhereItWas : to;
}

/** Removes the slide at `index`. `undefined` for a deck's last slide, which a deck can't be without. */
export function removeSlide(state: EditorState, index: number): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide || state.doc.childCount <= 1) return undefined;
	return state.tr.delete(slide.pos, slide.pos + slide.node.nodeSize);
}

/**
 * Puts the image `src`, its words `alt`, in the box that starts at `box`: on
 * its empty line, or on a line of its own after what it holds. `undefined`
 * when no box starts there any more.
 */
export function addImage(
	state: EditorState,
	box: number,
	{ src, alt }: { src: string; alt: string },
): Transaction | undefined {
	const holder = state.doc.nodeAt(box);
	if (holder?.type.name !== SLIDE_BOX) return undefined;
	const image = nodeType(state.schema, "image").create({ src, alt });
	const first = holder.firstChild;
	if (first?.type.name === "paragraph" && first.content.size === 0) {
		return state.tr.insert(inside(box), image);
	}
	const end = box + holder.nodeSize - 1;
	return state.tr.insert(end, nodeType(state.schema, "paragraph").create(null, image));
}

/**
 * Whether the slide's boxes wait on a suggestion: a new layout for it, or a
 * box somebody proposes adding or removing, as a new layout does. Until it is
 * settled, its frame may hold the boxes of two layouts.
 */
export function boxesWaitOnSuggestion(slide: Node): boolean {
	const newLayout = slide.marks.some(
		(mark) => mark.type.name === SUGGESTED_MODIFICATION && mark.attrs.attrName === "layout",
	);
	return (
		newLayout ||
		slide
			.child(0)
			.children.some((box) =>
				box.marks.some(
					(mark) => mark.type.name === SUGGESTED_INSERTION || mark.type.name === SUGGESTED_DELETION,
				),
			)
	);
}

/**
 * Places the box at `box`, on the slide starting at `slidePos`, at `frame`,
 * and its other boxes where they are: where the slide places them already,
 * or, on a slide its layout still places, where `drawn` says the layout draws
 * them, so the first box a person moves places the whole slide and moves
 * nothing else on it. `undefined` when no slide starts there, when its boxes
 * wait on a suggestion (see `boxesWaitOnSuggestion`), when the box is at
 * `frame` already, or when the frames are no placement for its layout.
 *
 * Where a box sits is never a suggestion, so it is placed at once, even while
 * the person is suggesting.
 */
export function placeBox(
	state: EditorState,
	slidePos: number,
	box: number,
	frame: Frame,
	drawn: readonly Frame[],
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE || boxesWaitOnSuggestion(slide)) return undefined;
	const before = placementOf(slide) ?? drawn;
	const was = before[box];
	if (!was || sameFrame(was, frame)) return undefined;
	const frames = before.map((each, index) => (index === box ? frame : each));
	const placement = placementIn(frames, layoutOf(slide));
	if (!placement) return undefined;
	return neverSuggested(state.tr.setNodeAttribute(slidePos, PLACEMENT, placement));
}

/**
 * Why a box can't be removed from its slide now: the person is suggesting,
 * and a removal is made at once, never as a suggestion, as where a box sits
 * is; or a suggestion waits in the box, which removing what it holds would
 * lose.
 */
export type BoxRemovalBlocked = "suggesting" | "suggestionPending";

export function boxRemovalBlocked(state: EditorState, box: Node): BoxRemovalBlocked | undefined {
	if (isSuggestChangesEnabled(state)) return "suggesting";
	if (holdsSuggestion(box)) return "suggestionPending";
	return undefined;
}

/**
 * Removes the box at `box` from the slide starting at `slidePos`, for
 * everybody: what it holds goes, leaving the line a box of its role is left
 * with, and it is marked as removed (`REMOVED`), which takes it off the slide
 * (`isRemovedBox`). It stays in the frame, so the frame still holds every box
 * its layout places, and a placed slide a frame for each, where undoing the
 * removal puts it back. One change, undone whole, with what the box held.
 * A caret left in the box is moved out of it (`selectionOutOfRemovedBox`).
 *
 * Like placing a box, it is never a suggestion. `undefined` when no slide
 * starts there, when its boxes wait on a suggestion (`boxesWaitOnSuggestion`),
 * when it has no such box or the box is off it already, or when
 * `boxRemovalBlocked` says why the box can't be removed.
 */
export function removeBox(
	state: EditorState,
	slidePos: number,
	box: number,
): Transaction | undefined {
	const slide = state.doc.nodeAt(slidePos);
	if (slide?.type.name !== SLIDE || boxesWaitOnSuggestion(slide)) return undefined;
	const removed = slide.child(0).maybeChild(box);
	const role = SLIDE_BOX_ROLES[layoutOf(slide)][box];
	const at = boxStarts(slide, slidePos)[box];
	if (
		!removed ||
		!role ||
		at === undefined ||
		isRemovedBox(removed) ||
		boxRemovalBlocked(state, removed)
	) {
		return undefined;
	}
	return neverSuggested(
		state.tr
			.setNodeAttribute(at, REMOVED, true)
			.replaceWith(
				at + 1,
				at + removed.nodeSize - 1,
				emptyLine(state.schema, layoutOf(slide), role),
			),
	);
}

/**
 * Moves a selection with an end in a box off its slide (`isRemovedBox`), where
 * it isn't seen and whatever is typed would put the box back, to the start of
 * the nearest box on that slide, the next or else the one before, or else to
 * the start of the slide's notes. However it got there: by the box's removal,
 * the removal of the slide before it, an undo, or a change from elsewhere.
 * `undefined` when neither end is in such a box.
 */
export function selectionOutOfRemovedBox(state: EditorState): Transaction | undefined {
	const { $from, $to } = state.selection;
	const holding = removedBoxHolding($from) ?? removedBoxHolding($to);
	if (!holding) return undefined;
	const { slide, slidePos, box } = holding;
	const indexes = boxIndexes(slide);
	const nearestFirst = [
		...indexes.filter((index) => index > box),
		...indexes.filter((index) => index < box).toReversed(),
	];
	return state.tr.setSelection(caretInFirstShownBox(state.doc, slidePos, nearestFirst));
}

/** The slide, where it starts, and the place on it of the box off it (`isRemovedBox`) holding `place`, if one does. */
function removedBoxHolding(place: ResolvedPos) {
	// A deck holds slides, which hold their frame, which holds the boxes.
	const inBox = place.depth >= 3 && place.node(2).type.name === SLIDE_BODY;
	if (!inBox || !isRemovedBox(place.node(3))) return undefined;
	return { slide: place.node(1), slidePos: place.before(1), box: place.index(2) };
}

/** Where each box of `slide`, which starts at `slidePos`, starts, in its order. */
function boxStarts(slide: Node, slidePos: number): number[] {
	const starts: number[] = [];
	slide.child(0).forEach((_, offset) => {
		starts.push(inside(slidePos) + offset);
	});
	return starts;
}

/** The places of `slide`'s boxes, in its order. */
const boxIndexes = (slide: Node): number[] => slide.child(0).children.map((_, index) => index);

/**
 * The caret at the start of the first of the boxes at `indexes`, on the slide
 * starting at `slidePos` in `deck`, that is on the slide, or at the start of
 * the slide's notes when none is: never in a box off the slide, which isn't
 * drawn, where whatever is typed would put it back.
 */
function caretInFirstShownBox(deck: Node, slidePos: number, indexes: readonly number[]): Selection {
	const slide = deck.nodeAt(slidePos);
	if (!slide) return TextSelection.near(deck.resolve(slidePos));
	const boxes = slide.child(0).children;
	const starts = boxStarts(slide, slidePos);
	const first = indexes.find((index) => {
		const box = boxes[index];
		return box !== undefined && !isRemovedBox(box);
	});
	const notesStart = slidePos + 1 + slide.child(0).nodeSize;
	const start = (first === undefined ? undefined : starts[first]) ?? notesStart;
	return TextSelection.near(deck.resolve(start + 1));
}

/**
 * Whether somebody laid the slide out by hand, which `resetLayout` takes back:
 * placed its boxes, or removed one of them from it.
 */
export const laidOutByHand = (slide: Node): boolean =>
	placementOf(slide) !== null || slide.child(0).children.some(isRemovedBox);

/**
 * Leaves the boxes of the slide at `index` to its layout again, as they were
 * before anybody placed them, and brings back every box removed from it,
 * holding the line it was left with. Like placing and removing them, it is
 * never a suggestion. `undefined` when nobody laid the slide out by hand
 * (`laidOutByHand`).
 */
export function resetLayout(state: EditorState, index: number): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide || !laidOutByHand(slide.node)) return undefined;
	const resetting = state.tr;
	if (slide.node.attrs[PLACEMENT] !== null) resetting.setNodeAttribute(slide.pos, PLACEMENT, null);
	bringBackRemovedBoxes(resetting, slide.pos);
	return neverSuggested(resetting);
}

/** Puts every box removed from the slide starting at `slidePos` back on it, holding what it holds. */
function bringBackRemovedBoxes(transaction: Transaction, slidePos: number): void {
	const slide = transaction.doc.nodeAt(slidePos);
	if (!slide) return;
	boxStarts(slide, slidePos).forEach((at, index) => {
		if (slide.child(0).child(index).attrs[REMOVED] !== null) {
			transaction.setNodeAttribute(at, REMOVED, null);
		}
	});
}

/** A stretch of the document, by position. */
interface Range {
	from: number;
	to: number;
}

/**
 * Keeps every slide this person changes holding what its layout says
 * (`fitSlideBody`), as when deleting across two of its boxes joins them, or a
 * paste brings it a box more than its layout places, in the same change.
 *
 * It leaves alone what arrives from the others: their editors fit their own
 * changes, and the API fits a bot's, so refitting here would only fight them.
 * And it leaves alone a slide with a suggestion waiting in it, whose frame
 * holds two layouts' boxes while a new layout is suggested.
 */
export const keepSlidesFitting = new Plugin({
	key: new PluginKey("keepSlidesFitting"),
	appendTransaction(transactions, _before, state) {
		const changed = changedHere(transactions);
		if (changed.length === 0) return null;
		const fitting = state.tr;
		for (const { node, pos } of slidesOf(state.doc)) {
			const touched = changed.some(({ from, to }) => from <= pos + node.nodeSize && to >= pos);
			if (!touched || holdsSuggestion(node)) continue;
			const body = node.child(0);
			const fitted = fitSlideBody(body, layoutOf(node));
			if (fitted === body) continue;
			replaceChangedChildren(
				fitting,
				fitting.mapping.map(inside(pos)),
				body.content,
				fitted.content,
			);
		}
		return fitting.docChanged ? fitting : null;
	},
});

/** Where in the document as they leave it the changes made in this editor fell, not those that arrived from elsewhere. */
function changedHere(transactions: readonly Transaction[]): Range[] {
	return transactions.flatMap((transaction, index) => {
		if (!transaction.docChanged || isChangeOrigin(transaction)) return [];
		const later = transactions.slice(index + 1);
		return getChangedRanges(transaction).map(({ newRange }) =>
			later.reduce(
				(range, next) => ({
					from: next.mapping.map(range.from, -1),
					to: next.mapping.map(range.to, 1),
				}),
				newRange,
			),
		);
	});
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
