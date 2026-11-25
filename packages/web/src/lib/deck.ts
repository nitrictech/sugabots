import { revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import {
	holdsSuggestion,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
} from "@sugabots/contracts/live-document";
import { fitSlideBody, layoutOf, newSlide, SLIDE_COLUMN } from "@sugabots/contracts/live-slides";
import type { SlideLayout } from "@sugabots/contracts/slides-markdown";
import { getChangedRanges } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Fragment, Node, NodeType, Schema } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";

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

/** Where a slide starting at `pos` holds its first block: past its own start and its frame's. */
const inside = (pos: number) => pos + 2;

/** Puts the caret at the start of the slide at `index`. */
export function selectSlide(state: EditorState, index: number): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide) return undefined;
	return state.tr.setSelection(TextSelection.near(state.doc.resolve(inside(slide.pos))));
}

/**
 * Lays the slide at `index` out by `layout`, moving what its frame holds to
 * fit (`fitSlideBody`), which loses nothing. Only the blocks that move are
 * replaced, so somebody typing in the slide's title keeps what they type.
 * `undefined` when the slide has that layout already, or when a suggestion
 * waits in it (see `holdsSuggestion`): its frame may hold two layouts'
 * content until that is settled, and a suggestion in a block that moves would
 * be lost.
 */
export function changeLayout(
	state: EditorState,
	index: number,
	layout: SlideLayout,
): Transaction | undefined {
	const slide = slidesOf(state.doc)[index];
	if (!slide || layoutOf(slide.node) === layout || holdsSuggestion(slide.node)) return undefined;
	const body = slide.node.child(0);
	// The layout first, as the API's change does: setting it moves nothing still to be replaced.
	const changing = state.tr.setNodeAttribute(slide.pos, "layout", layout);
	replaceChangedChildren(
		changing,
		inside(slide.pos),
		body.content,
		fitSlideBody(body, layout).content,
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
 * Puts the image `src`, its words `alt`, in the column that starts at
 * `column`: on its empty line, or on a line of its own after what it holds.
 * `undefined` when no column starts there any more.
 */
export function addImage(
	state: EditorState,
	column: number,
	{ src, alt }: { src: string; alt: string },
): Transaction | undefined {
	const holder = state.doc.nodeAt(column);
	if (holder?.type.name !== SLIDE_COLUMN) return undefined;
	const image = nodeType(state.schema, "image").create({ src, alt });
	const first = holder.firstChild;
	if (first?.type.name === "paragraph" && first.content.size === 0) {
		return state.tr.insert(inside(column), image);
	}
	const end = column + holder.nodeSize - 1;
	return state.tr.insert(end, nodeType(state.schema, "paragraph").create(null, image));
}

/** A stretch of the document, by position. */
interface Range {
	from: number;
	to: number;
}

/**
 * Keeps every slide this person changes holding what its layout says
 * (`fitSlideBody`), as when deleting across its two columns joins them, or a
 * paste brings columns into a slide that has none, in the same change.
 *
 * It leaves alone what arrives from the others: their editors fit their own
 * changes, and the API fits a bot's, so refitting here would only fight them.
 * And it leaves alone a slide with a suggestion waiting in it, whose frame
 * holds two layouts' content while a new layout is suggested.
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
