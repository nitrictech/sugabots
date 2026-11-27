import { isDeepStrictEqual } from "node:util";
import {
	revertSuggestions,
	suggestChanges,
	suggestChangesKey,
	transformToSuggestionTransaction,
} from "@handlewithcare/prosemirror-suggest-changes";
import type { DeckUnreadable } from "@sugabots/contracts/deck-html";
import {
	NODE_SUGGESTION,
	SUGGESTED_INSERTION,
	type SuggestionBy,
	suggestionBy,
	suggestionsAsAttributes,
} from "@sugabots/contracts/live-document";
import {
	liveDocumentFromText,
	liveDocumentKind,
	readLiveDocumentText,
	textOfLiveDocument,
} from "@sugabots/contracts/live-document-text";
import { bodyOf, boxAttributesOf, SLIDE, SLIDE_BOX } from "@sugabots/contracts/live-slides";
import type { BoxAttributes } from "@sugabots/contracts/slide-box";
import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import { Fragment, Mark, type Node, Slice } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { type Mappable, Transform } from "@tiptap/pm/transform";
import { readHtml } from "./html-reader.ts";

/*
 * An agent's change to a live document. The agent reads the document as its
 * text without its pending suggestions (`textWithoutSuggestions`), a
 * document's markdown or a deck's HTML, and writes the text it should read
 * as instead. `changedTo` applies only what the agent changed in that text:
 * everything else stays as the document holds it, which may be more than its
 * text says. The difference is found block by block, then word by word, and
 * only that much is changed, so what people are typing elsewhere, and the
 * suggestions waiting there, are left alone.
 *
 * The change is made at once, or handed to the suggesting library to write
 * into the document as one suggestion, exactly as it writes a person's: its
 * words, the blocks, boxes and slides it adds or removes, and how a deck
 * looks alike. The library keeps a node's attribute changed in a
 * modification mark holding what it was, as a box's frame or a slide's
 * background (`isDesignAttribute`), and a text style changed as its words
 * replaced by themselves restyled. It keeps no node's place among its
 * siblings, so a box moved in front of or behind another is moved at once
 * (`withBoxesMoved`).
 */

/** How a change is made: at once, or as the suggestion with this id. */
export type ChangeAs = "edit" | { suggestionId: string };

/**
 * Why the text an agent wrote can't be what the document reads as, in which
 * case nothing is changed: a deck's HTML that holds no slide and nothing a
 * slide could (`saysNothing`), as a deck always has a slide and HTML only
 * says none by mistake; or one that can't be read whole (see
 * `DeckUnreadable`). A document's markdown always reads as a document.
 */
export type TextRefused = "saysNothing" | DeckUnreadable;

/**
 * Why an agent's change is refused, none of it made: it was to be a
 * suggestion, and it changes text that can't carry a suggestion's marks, as
 * a code block's can't (`unmarkable`); or the text it wrote can't be what the
 * document reads as (see `TextRefused`).
 */
export type Refused = "unmarkable" | TextRefused;

/**
 * What an agent's change did to a live document: `made`, the document after
 * it with all of it made; `suggested`, the document after it with what it
 * changes waiting as one suggestion, but for the boxes it moved among their
 * slide's others (see `withBoxesMoved`); `unchanged`, as it asked for nothing
 * the document doesn't hold already; or `refused`, and why.
 */
export type Change =
	| { readonly outcome: "made" | "suggested"; readonly document: Node }
	| { readonly outcome: "unchanged" }
	| { readonly outcome: "refused"; readonly reason: Refused };

/** The document as people see it until somebody accepts a suggestion pending in it: every pending suggestion left out. */
export function withoutSuggestions(document: Node): Node {
	return plain(reverted(document));
}

/**
 * The document as an agent reads it, and changes it with `changedTo`: as its
 * text (see `textOfLiveDocument`), without its pending suggestions.
 */
export const textWithoutSuggestions = (document: Node): string =>
	textOfLiveDocument(withoutSuggestions(document));

/**
 * `live` changed as an agent asks, by writing `wanted` in place of the text
 * it read, `textWithoutSuggestions(live)`. What it left as it read it stays
 * as `live` holds it; what it changed is made to read, pending suggestions
 * aside, as `wanted` says, made `as` asked (see `Change`).
 */
export function changedTo(live: Node, wanted: string, as: ChangeAs): Change {
	const kind = liveDocumentKind(live);
	const reading = readLiveDocumentText(kind, wanted, readHtml);
	if (reading.outcome === "nothing") return { outcome: "refused", reason: "saysNothing" };
	if (reading.outcome === "unreadable") return { outcome: "refused", reason: reading.reason };
	const unsettled = reverted(live);
	const read = plain(unsettled);
	// The document's own text always reads back as a document of its kind.
	const shown = liveDocumentFromText(kind, textOfLiveDocument(read), readHtml);
	const target = withChangesOf(read, shown, reading.document);
	const moved = withBoxesMoved(live, read, target, unsettled.mapping.invert());
	const base = moved ?? live;
	const revert = moved ? reverted(moved) : unsettled;
	const before = plain(revert);
	// The differences are places in the document without its suggestions, so each is found in the live one.
	const inLive = revert.mapping.invert();
	const found: Found = { replacements: [], attributes: [], restyles: [], unmarkable: false };
	findDifferences(before, target, 0, found, as === "edit" ? "apart" : "withWords");
	// An attribute the live node has already, as one an earlier suggestion of the same change gave it, is left as it is.
	const attributes = found.attributes.filter(
		({ at, name, value }) => !isDeepStrictEqual(base.nodeAt(inLive.map(at, 1))?.attrs[name], value),
	);
	const { replacements, restyles } = found;
	if (replacements.length === 0 && attributes.length === 0 && restyles.length === 0) {
		return moved ? { outcome: "made", document: moved } : { outcome: "unchanged" };
	}
	if (as !== "edit" && found.unmarkable) return { outcome: "refused", reason: "unmarkable" };
	if (as === "edit") {
		const change = new Transform(base);
		for (const { at, name, value } of attributes) {
			change.setNodeAttribute(inLive.map(at, 1), name, value);
		}
		for (const restyle of restyles) setTextStyle(change, restyle, inLive);
		replaceEach(change, replacements, inLive, undefined);
		return { outcome: "made", document: change.doc };
	}
	const off = EditorState.create({ doc: base, plugins: [suggestChanges()] });
	const state = off.apply(off.tr.setMeta(suggestChangesKey, { enabled: true }));
	const change = state.tr;
	// First, as changing an attribute moves nothing still to be changed.
	for (const { at, name, value } of attributes) {
		change.setNodeAttribute(inLive.map(at, 1), name, value);
	}
	replaceEach(change, replacements, inLive, suggestionBy(as.suggestionId));
	const suggestion = transformToSuggestionTransaction(change, state, () => as.suggestionId);
	return { outcome: "suggested", document: suggestion.doc };
}

/**
 * Makes each replacement in `change`, found in the live document by
 * `inLive`, from the end, so that a replacement never moves the places still
 * to be replaced. A replacement stops short of what somebody proposes adding
 * at either edge, which is theirs to settle; but when it is a suggestion of
 * `author`'s, it takes in what they propose adding there already, so a
 * suggestion of theirs made again replaces the one waiting rather than
 * adding beside it.
 */
function replaceEach(
	change: Transform,
	replacements: readonly Replacement[],
	inLive: Mappable,
	author: SuggestionBy | undefined,
): void {
	for (const { from, to, slice } of replacements.toReversed()) {
		const start = inLive.map(from, 1);
		const end = Math.max(start, inLive.map(to, -1));
		const [reachFrom, reachTo] = author
			? overInsertionsBy(change.doc, start, end, author)
			: [start, end];
		change.replace(reachFrom, reachTo, slice);
	}
}

/** `start` and `end`, in `document`, moved out over what `author` proposes adding at either side of them. */
function overInsertionsBy(
	document: Node,
	start: number,
	end: number,
	author: SuggestionBy,
): [number, number] {
	let from = start;
	for (let node = document.resolve(from).nodeBefore; node && isInsertionBy(node, author); ) {
		from -= node.nodeSize;
		node = document.resolve(from).nodeBefore;
	}
	let to = end;
	for (let node = document.resolve(to).nodeAfter; node && isInsertionBy(node, author); ) {
		to += node.nodeSize;
		node = document.resolve(to).nodeAfter;
	}
	return [from, to];
}

/** Whether `node` is proposed for adding, in a suggestion of `author`'s. */
const isInsertionBy = (node: Node, author: SuggestionBy) =>
	node.marks.some((mark) => {
		if (mark.type.name !== SUGGESTED_INSERTION) return false;
		const by = suggestionBy(mark.attrs.id);
		return by.kind === author.kind && by.name === author.name;
	});

/**
 * Gives the stretch of text `restyle` says, found in the live document by
 * `inLive`, the text style it says, and what somebody proposes adding at
 * either edge of it too, so that the line reads in one style however that is
 * settled.
 */
function setTextStyle(change: Transform, { from, to, style }: Restyle, inLive: Mappable): void {
	const [start, end] = [inLive.map(from, -1), inLive.map(to, 1)];
	const textStyle = change.doc.type.schema.marks[TEXT_STYLE];
	if (!textStyle || end <= start) return;
	change.removeMark(start, end, textStyle);
	if (style) change.addMark(start, end, style);
}

/**
 * `live` with the boxes on each slide in the order `target` puts them in,
 * where that differs from `before`'s, moved whole, with whatever waits in
 * them, at once; `undefined` when no box moves. The order is the one boxes
 * are drawn in, each over those before it, which a suggestion can't hold:
 * the suggesting library keeps what a node's attributes were, and what was
 * added or removed, but not where a node stood among its siblings. `before`
 * is `live` without its suggestions, whose places `inLive` finds in it.
 */
function withBoxesMoved(
	live: Node,
	before: Node,
	target: Node,
	inLive: Mappable,
): Node | undefined {
	const change = new Transform(live);
	let slideAt = 0;
	for (const { was, becomes } of aligned(before.children, target.children)) {
		if (was && becomes && isSlide(was) && isSlide(becomes)) {
			const boxes = bodyOf(was).children;
			const targetIndexOf = new Map(boxPairs(boxes, bodyOf(becomes).children));
			// The slide's body starts just inside the slide, and its boxes just inside that.
			const boxStarts = boxes.map((_, index) =>
				inLive.map(slideAt + 2 + offsetOf(bodyOf(was), index), 1),
			);
			const targetIndexAt = new Map(
				boxStarts.flatMap((start, index) => {
					const targetIndex = targetIndexOf.get(index);
					return targetIndex === undefined ? [] : [[start, targetIndex] as const];
				}),
			);
			moveBoxes(change, inLive.map(slideAt, 1) + 1, targetIndexAt);
		}
		if (was) slideAt += was.nodeSize;
	}
	return change.docChanged ? change.doc : undefined;
}

/** Where the child `index` of `parent` starts, counted from where `parent`'s content starts. */
function offsetOf(parent: Node, index: number): number {
	let offset = 0;
	for (let child = 0; child < index; child++) offset += parent.child(child).nodeSize;
	return offset;
}

/**
 * Puts the boxes of the slide's body starting at `bodyAt` in `change` in the
 * order of their indexes in the slide the agent wrote, `targetIndexAt`, by
 * where each starts. A box the agent didn't write, as one it removes or one
 * somebody proposes adding, keeps its place after the box before it.
 */
function moveBoxes(
	change: Transform,
	bodyAt: number,
	targetIndexAt: ReadonlyMap<number, number>,
): void {
	const body = () => change.doc.nodeAt(bodyAt) as Node;
	const startOf = (index: number) => bodyAt + 1 + offsetOf(body(), index);
	// Runs of boxes, each led by one the agent wrote, with those that follow it.
	const runs: { targetIndex: number; boxes: number[] }[] = [{ targetIndex: -1, boxes: [] }];
	body().forEach((_, _offset, index) => {
		const targetIndex = targetIndexAt.get(startOf(index));
		if (targetIndex !== undefined) runs.push({ targetIndex, boxes: [index] });
		else runs.at(-1)?.boxes.push(index);
	});
	const wanted = runs.toSorted((one, other) => one.targetIndex - other.targetIndex);
	const order = wanted.flatMap((run) => run.boxes);
	const current = order.toSorted((one, other) => one - other);
	order.forEach((box, place) => {
		const at = current.indexOf(box);
		if (at === place) return;
		const node = body().child(at);
		const from = startOf(at);
		change.delete(from, from + node.nodeSize);
		change.insert(startOf(place), node);
		current.splice(at, 1);
		current.splice(place, 0, box);
	});
}

/**
 * `before` with the changes an agent made, and no others. The agent read
 * `before` as text, which `shown` is read back from, and wrote the text
 * `wanted` is read from. Wherever `wanted` holds what `shown` does,
 * `before`'s own blocks stay, so what the text can't say about them, as
 * markdown can't say all a document holds, is never lost to a change made
 * elsewhere. Where it doesn't, `wanted`'s blocks take their place, a block
 * holding others having its own changes found inside it the same way.
 */
function withChangesOf(before: Node, shown: Node, wanted: Node): Node {
	if (shown.eq(wanted)) return before;
	const content = Fragment.fromArray(childrenWithChangesOf(before, shown, wanted));
	// Blocks of `before` beside blocks of `wanted` might not be what this block may hold; then it is `wanted`'s.
	if (!before.type.validContent(content)) return wanted;
	const attributes = Object.fromEntries(
		Object.entries(wanted.attrs).map(([name, value]) => [
			name,
			isDeepStrictEqual(shown.attrs[name], value) ? before.attrs[name] : value,
		]),
	);
	return before.type.create(attributes, content, before.marks);
}

/** `before`'s children, with the changes an agent made to them (see `withChangesOf`). */
function childrenWithChangesOf(before: Node, shown: Node, wanted: Node): Node[] {
	const runs = readAs(before.content.content, shown.content.content);
	// The index of the run each child of `shown` is in.
	const runOf = runs.flatMap((run, index) => run.shown.map(() => index));
	const steps = aligned(shown.content.content, wanted.content.content);
	const changed = changedRuns(steps, runOf);
	const children: Node[] = [];
	// The runs before `written` are written, or are being written step by step.
	let written = 0;
	const writeUnchangedRunsBefore = (end: number) => {
		for (; written < end; written++) {
			if (!changed.has(written)) children.push(...(runs[written]?.before ?? []));
		}
	};
	let shownIndex = 0;
	for (const { was, becomes } of steps) {
		if (!was) {
			if (becomes) children.push(becomes);
			continue;
		}
		// Every child of `shown` is in a run, and the steps take them in order.
		const runIndex = runOf[shownIndex++] as number;
		if (!changed.has(runIndex)) {
			writeUnchangedRunsBefore(runIndex + 1);
			continue;
		}
		writeUnchangedRunsBefore(runIndex);
		if (!becomes) continue;
		const run = runs[runIndex] as ReadAs;
		const [only] = run.before;
		const readBackAlone = only !== undefined && run.before.length === 1 && run.shown.length === 1;
		children.push(
			readBackAlone && oneBlockHoldingOthers(only, was, becomes)
				? withChangesOf(only, was, becomes)
				: becomes,
		);
	}
	writeUnchangedRunsBefore(runs.length);
	return children;
}

/**
 * Whether three blocks are of one kind that holds other blocks, as a slide
 * or a list is, so that an agent's change from one to another is found inside
 * them, child by child.
 */
const oneBlockHoldingOthers = (before: Node, shown: Node, wanted: Node) =>
	!before.isTextblock && !before.isLeaf && before.type === shown.type && shown.type === wanted.type;

/**
 * A run of `before`'s blocks and the run of blocks they read back as from
 * their text. Mostly one block each; but reading markdown back may join two
 * blocks into one, as two lists side by side, or make none of a block, so a
 * run is what stands between blocks that read back as they were.
 */
interface ReadAs {
	before: readonly Node[];
	shown: readonly Node[];
}

/** `before`, blocks side by side, matched up in runs with `shown`, what they read back as. */
function readAs(before: readonly Node[], shown: readonly Node[]): ReadAs[] {
	// Each block reads back as one block in its place, unless reading back made more or fewer.
	if (before.length === shown.length) return oneForOne(before, shown);
	const runs: ReadAs[] = [];
	let [from, fromShown] = [0, 0];
	for (const [index, indexShown] of [
		...longestCommon(before, shown, (was, read) => was.eq(read)),
		[before.length, shown.length] as const,
	]) {
		const between = {
			before: before.slice(from, index),
			shown: shown.slice(fromShown, indexShown),
		};
		if (between.before.length === between.shown.length) {
			runs.push(...oneForOne(between.before, between.shown));
		} else runs.push(between);
		const [was, read] = [before[index], shown[indexShown]];
		if (was && read) runs.push({ before: [was], shown: [read] });
		[from, fromShown] = [index + 1, indexShown + 1];
	}
	return runs;
}

const oneForOne = (before: readonly Node[], shown: readonly Node[]): ReadAs[] =>
	before.map((was, index) => ({ before: [was], shown: shown.slice(index, index + 1) }));

/**
 * The runs, by index, that the agent changed: a block of the run it changed
 * or removed, or a block it added between two of the run's.
 */
function changedRuns(steps: readonly Step[], runOf: readonly number[]): Set<number> {
	const changed = new Set<number>();
	let shownIndex = 0;
	for (const { was, becomes } of steps) {
		if (was) {
			// Every child of `shown` is in a run, and the steps take them in order.
			const runIndex = runOf[shownIndex++] as number;
			if (!(becomes && was.eq(becomes))) changed.add(runIndex);
			continue;
		}
		const [runBefore, runAfter] = [runOf[shownIndex - 1], runOf[shownIndex]];
		if (runBefore !== undefined && runBefore === runAfter) changed.add(runBefore);
	}
	return changed;
}

/**
 * The document a `reverted` transaction leaves, with no block still saying in
 * its attribute that something is suggested for it. Every place in it is
 * where the transaction left it.
 */
const plain = (revert: Transaction) => suggestionsAsAttributes(revert.doc);

/** The transaction that takes every pending suggestion out of the document, whose mapping says where each place went. */
function reverted(document: Node): Transaction {
	const state = EditorState.create({ doc: document });
	let revert = state.tr;
	revertSuggestions(state, (transaction) => {
		revert = transaction;
	});
	return revert;
}

/** A stretch of the document without its suggestions, and what goes in its place. */
interface Replacement {
	from: number;
	to: number;
	slice: Slice;
}

/** A new value for an attribute of the node starting at `at`, which stays where it is. */
interface AttributeChange {
	at: number;
	name: string;
	value: unknown;
}

/** A stretch of a line of the document without its suggestions, and the text style to give it: none to take its style away. */
interface Restyle {
	from: number;
	to: number;
	style: Mark | undefined;
}

interface Found {
	replacements: Replacement[];
	/** Changes to how a deck looks, of a node's attributes (see `isDesignAttribute`). */
	attributes: AttributeChange[];
	/** Changes to how a deck's text is styled, apart from its words. */
	restyles: Restyle[];
	/** Whether a replacement is inside text that can't carry a suggestion's marks. */
	unmarkable: boolean;
}

/**
 * How a change of a deck's text style is found: as a restyle, made apart
 * from the words (`apart`), as an edit makes it; or as a change of the words
 * it styles, which are replaced by themselves restyled (`withWords`), as the
 * suggesting library holds a change to a mark on text.
 */
type TextStyleChanges = "apart" | "withWords";

const isSlide = (node: Node) => node.type.name === SLIDE;

const isBox = (node: Node) => node.type.name === SLIDE_BOX;

/** The attributes of a box that say how it looks: all of them, listed so that one added later is decided on here. */
const BOX_DESIGN: Readonly<Record<keyof BoxAttributes, true>> = {
	role: true,
	frame: true,
	fill: true,
	stroke: true,
	path: true,
	verticalAlign: true,
	padding: true,
	rotation: true,
};

/** The attributes of a paragraph or heading that say how a deck's text looks (see `slide-text-style.ts`). */
const LINE_DESIGN: ReadonlySet<string> = new Set(["textAlign", "lineHeight"]);

/** The attributes of each kind of node that say how a deck looks, by the node's name. */
const DESIGN_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
	[SLIDE]: new Set(["layout", "background"]),
	[SLIDE_BOX]: new Set(Object.keys(BOX_DESIGN)),
	paragraph: LINE_DESIGN,
	heading: LINE_DESIGN,
};

/**
 * Whether `name` is an attribute of `node` that says how a deck looks: a
 * slide's layout and background, any of a box's (see `BoxAttributes`), and a
 * line's alignment and line height. A change to one is a change of the node
 * where it is; a change to any other attribute, as a heading's level, or one
 * this list doesn't know, replaces the node.
 */
const isDesignAttribute = (node: Node, name: string) =>
	DESIGN_ATTRIBUTES[node.type.name]?.has(name) ?? false;

/** The attributes `becomes` has that `was` doesn't, compared by value, but for what is suggested for it. */
const differingAttributes = (was: Node, becomes: Node): string[] =>
	Object.keys(becomes.attrs).filter(
		(name) => name !== NODE_SUGGESTION && !isDeepStrictEqual(was.attrs[name], becomes.attrs[name]),
	);

/**
 * Whether `was` and `becomes` are one node, compared inside, rather than one
 * replacing the other: of one kind that holds others, and alike but for how
 * a deck looks (`isDesignAttribute`), which is changed on it where it is. So
 * a slide or a box keeps its place, with what somebody is typing in it, when
 * it is moved or restyled. Any other node whose attributes change, as a
 * heading's level, is replaced.
 */
const comparedInside = (was: Node, becomes: Node) =>
	!was.isLeaf &&
	was.type === becomes.type &&
	Mark.sameSet(was.marks, becomes.marks) &&
	differingAttributes(was, becomes).every((name) => isDesignAttribute(was, name));

/** The attributes `becomes` has that `was`, at `at`, doesn't (see `differingAttributes`). */
const attributeChanges = (was: Node, becomes: Node, at: number): AttributeChange[] =>
	differingAttributes(was, becomes).map((name) => ({ at, name, value: becomes.attrs[name] }));

/**
 * Adds to `found` what must be replaced for `before`'s children to read as
 * `after`'s do. A child that reads the same is left, one compared inside
 * (`comparedInside`) has its differences found inside it, and the rest are
 * removed or added, a run at a time. `start` is where `before`'s content
 * begins in the document.
 */
function findDifferences(
	before: Node,
	after: Node,
	start: number,
	found: Found,
	styles: TextStyleChanges,
): void {
	let position = start;
	// Blocks removed and added side by side are one replacement, not a removal beside an addition.
	let run: { from: number; to: number; added: Node[] } | undefined;
	const endRun = () => {
		if (run) {
			found.replacements.push({
				from: run.from,
				to: run.to,
				slice: new Slice(Fragment.fromArray(run.added), 0, 0),
			});
			if (run.added.some((node) => !canHoldSuggestions(node))) found.unmarkable = true;
		}
		run = undefined;
	};
	for (const { was, becomes } of aligned(before.content.content, after.content.content)) {
		if (was && becomes && comparedInside(was, becomes)) {
			endRun();
			if (!was.eq(becomes)) {
				found.attributes.push(...attributeChanges(was, becomes, position));
				if (was.isTextblock) findTextDifference(was, becomes, position + 1, found, styles);
				else findDifferences(was, becomes, position + 1, found, styles);
			}
		} else {
			run ??= { from: position, to: position, added: [] };
			if (was) run.to = position + was.nodeSize;
			if (becomes) run.added.push(becomes);
		}
		if (was) position += was.nodeSize;
	}
	endRun();
}

/**
 * Adds to `found` the words of a line that differ and the words that replace
 * them. Whole words, so a suggestion reads as "~~Friday~~ Monday" and not
 * "~~Fri~~Mon". A word differs when its text, its marks or an image in it
 * does, so a change that only marks a word, or swaps an image, is found too.
 * A change of its text style alone is a word that differs too, or, with
 * `styles` `apart`, a restyle of the words that stay. `start` is where the
 * line's text begins in the document.
 */
function findTextDifference(
	before: Node,
	after: Node,
	start: number,
	found: Found,
	styles: TextStyleChanges,
): void {
	const [was, becomes] = [lineOf(before), lineOf(after)];
	const samePlace = styles === "apart" ? samePlaceButStyle : samePlaceAndStyle;
	const shorter = Math.min(was.length, becomes.length);
	let same = 0;
	while (same < shorter && samePlace(was[same], becomes[same])) same++;
	if (same === was.length && same === becomes.length) {
		found.restyles.push(...restylesOf(was, becomes, keptAtEnds(was, becomes, same, 0), start));
		return;
	}
	while (same > 0 && !isSpace(was[same - 1])) same--;
	let sameAtEnd = 0;
	while (
		sameAtEnd < shorter - same &&
		samePlace(was.at(-1 - sameAtEnd), becomes.at(-1 - sameAtEnd))
	) {
		sameAtEnd++;
	}
	while (sameAtEnd > 0 && !isSpace(was.at(-sameAtEnd))) sameAtEnd--;
	found.restyles.push(
		...restylesOf(was, becomes, keptAtEnds(was, becomes, same, sameAtEnd), start),
	);
	found.replacements.push({
		from: start + same,
		to: start + was.length - sameAtEnd,
		slice: new Slice(after.content.cut(same, becomes.length - sameAtEnd), 0, 0),
	});
	if (!canHoldSuggestions(before)) found.unmarkable = true;
}

/**
 * One place in a line: a character of its text with the marks on it, or a
 * node that isn't text, such as an image, which takes one place too. So an
 * index into a line's places is a position in the line.
 */
interface Place {
	character: string;
	marks: readonly Mark[];
	node?: Node;
}

/** Stands for a place in a line that isn't text. */
const NOT_TEXT = "￼";

function lineOf(textblock: Node): Place[] {
	const places: Place[] = [];
	textblock.forEach((child) => {
		if (!child.isText) {
			places.push({ character: NOT_TEXT, marks: child.marks, node: child });
			return;
		}
		const text = child.text ?? "";
		for (let index = 0; index < text.length; index++) {
			places.push({ character: text.charAt(index), marks: child.marks });
		}
	});
	return places;
}

const isTextStyle = (mark: Mark) => mark.type.name === TEXT_STYLE;

const withoutTextStyle = (marks: readonly Mark[]) => marks.filter((mark) => !isTextStyle(mark));

/** Whether two places hold the same, their marks as they are compared by `marksOf`. */
const samePlaceBy =
	(marksOf: (marks: readonly Mark[]) => readonly Mark[]) =>
	(one: Place | undefined, other: Place | undefined) =>
		one !== undefined &&
		other !== undefined &&
		one.character === other.character &&
		Mark.sameSet(marksOf(one.marks), marksOf(other.marks)) &&
		(one.node && other.node
			? one.node.mark(Mark.none).eq(other.node.mark(Mark.none))
			: one.node === other.node);

/** Whether two places hold the same, text style and all. */
const samePlaceAndStyle = samePlaceBy((marks) => marks);

/** Whether two places hold the same, their text styles aside, which a restyle changes. */
const samePlaceButStyle = samePlaceBy(withoutTextStyle);

const isSpace = (place: Place | undefined) => place !== undefined && /\s/.test(place.character);

/**
 * The places two lines keep when the first `same` of each and the last
 * `sameAtEnd` of each stay, as pairs of an index in `was` and one in
 * `becomes`.
 */
function keptAtEnds(
	was: readonly Place[],
	becomes: readonly Place[],
	same: number,
	sameAtEnd: number,
): (readonly [number, number])[] {
	const atStart = Array.from({ length: same }, (_, index) => [index, index] as const);
	const atEnd = Array.from(
		{ length: sameAtEnd },
		(_, back) => [was.length - sameAtEnd + back, becomes.length - sameAtEnd + back] as const,
	);
	return [...atStart, ...atEnd];
}

/**
 * What gives `was`, a line starting at `start`, the text styles of
 * `becomes` at the places they share, each pair an index in `was` and one in
 * `becomes`: a restyle for each run of places given one style.
 */
function restylesOf(
	was: readonly Place[],
	becomes: readonly Place[],
	shared: readonly (readonly [number, number])[],
	start: number,
): Restyle[] {
	const restyles: Restyle[] = [];
	for (const [index, indexBecomes] of shared) {
		const style = becomes[indexBecomes]?.marks.find(isTextStyle);
		if (sameStyle(was[index]?.marks.find(isTextStyle), style)) continue;
		const at = start + index;
		const last = restyles.at(-1);
		if (last && last.to === at && sameStyle(last.style, style)) last.to = at + 1;
		else restyles.push({ from: at, to: at + 1, style });
	}
	return restyles;
}

const sameStyle = (one: Mark | undefined, other: Mark | undefined) =>
	one === undefined || other === undefined ? one === other : one.eq(other);

/** Whether every line of text in the node can carry a suggestion's marks, which a code block's can't. */
function canHoldSuggestions(node: Node): boolean {
	const insertion = node.type.schema.marks[SUGGESTED_INSERTION];
	if (!insertion) return false;
	let markable = true;
	const check = (candidate: Node) => {
		if (candidate.isTextblock && !candidate.type.allowsMarkType(insertion)) markable = false;
	};
	check(node);
	node.descendants(check);
	return markable;
}

/** A block and what it becomes: both for one that stays, `was` alone for one removed, `becomes` alone for one added. */
interface Step {
	was?: Node;
	becomes?: Node;
}

/** Whether two things are taken for the same one, one way of matching them. */
type Matching<T> = (was: T, becomes: T) => boolean;

/**
 * `before`, sibling blocks, matched up with `after`, in steps in their order.
 * Slides and other blocks keep their order: those matched the strictest way
 * are matched first, and between them the next way, and so on, what is left
 * being removed and added. A slide's boxes are matched as a set instead (see
 * `boxPairs`), so a box drawn in front of another rather than behind it is
 * still the box it was.
 */
function aligned(before: readonly Node[], after: readonly Node[]): Step[] {
	const first = before[0] ?? after[0];
	if (!first) return [];
	if (isBox(first)) return stepsOf(before, after, boxPairs(before, after));
	if (isSlide(first)) {
		return alignedInOrder(before.map(slideKeys), after.map(slideKeys), SLIDE_MATCHINGS).map(
			({ was, becomes }) => ({ was: was?.slide, becomes: becomes?.slide }),
		);
	}
	return alignedInOrder(before, after, BLOCK_MATCHINGS);
}

/**
 * How blocks other than slides and boxes are matched, strictest first: those
 * that read the same, then blocks of one kind, so a paragraph is compared
 * with a paragraph and never with the list beside it.
 */
const BLOCK_MATCHINGS: readonly Matching<Node>[] = [
	(was, becomes) => was.eq(becomes),
	(was, becomes) => was.sameMarkup(becomes) || comparedInside(was, becomes),
];

/** A slide, with what it is known by: its title (`titleOf`), and what each of its boxes says that says something. */
interface SlideKeys {
	readonly slide: Node;
	readonly title: string;
	readonly sayings: ReadonlySet<string>;
}

const slideKeys = (slide: Node): SlideKeys => ({
	slide,
	title: titleOf(slide),
	sayings: new Set(
		bodyOf(slide)
			.children.map(sayingOf)
			.filter((saying) => saying !== ""),
	),
});

/**
 * How slides are matched, strictest first: those that read the same; then
 * slides with the same title, so a slide added beside one that changed isn't
 * taken for it; then slides sharing a box that says the same; then any.
 */
const SLIDE_MATCHINGS: readonly Matching<SlideKeys>[] = [
	(was, becomes) => was.slide.eq(becomes.slide),
	(was, becomes) => was.title !== "" && was.title === becomes.title,
	(was, becomes) => [...was.sayings].some((saying) => becomes.sayings.has(saying)),
	() => true,
];

/**
 * A slide's title: the words of its title box, or, when it has none or that
 * is empty, of the first line with words in it, in the order its boxes are
 * drawn.
 */
function titleOf(slide: Node): string {
	const titleBox = bodyOf(slide).children.find((box) => boxAttributesOf(box).role === "title");
	const title = titleBox?.textContent.trim() ?? "";
	if (title !== "") return title;
	let line = "";
	slide.descendants((node) => {
		if (line === "" && node.isTextblock) line = node.textContent.trim();
		return line === "";
	});
	return line;
}

/** The node an image in a line is. */
const IMAGE = "image";

/** What a box says: its words, and each image in it as its address. */
const sayingOf = (box: Node) =>
	box.textBetween(0, box.content.size, "\n", (leaf) =>
		leaf.type.name === IMAGE ? `[${String(leaf.attrs.src)}]` : "",
	);

/** A box, with what it is known by. */
interface BoxKeys {
	readonly box: Node;
	readonly attributes: BoxAttributes;
	readonly saying: string;
}

const boxKeys = (box: Node): BoxKeys => ({
	box,
	attributes: boxAttributesOf(box),
	saying: sayingOf(box),
});

/**
 * The ways two of a slide's boxes are taken for the same box, strictest
 * first, as an agent may move, restyle and reword a box, and add and remove
 * others beside it: the same box; one saying the same, as a box moved or
 * restyled; one where it was, as a box reworded; one for the same thing, as
 * a title moved and reworded; and one shape for another. A box saying
 * nothing is never taken for another by that alone, as an empty subtitle
 * removed beside a shape added.
 */
const BOX_MATCHINGS: readonly Matching<BoxKeys>[] = [
	(was, becomes) => was.box.eq(becomes.box),
	(was, becomes) => was.saying !== "" && was.saying === becomes.saying,
	(was, becomes) => isDeepStrictEqual(was.attributes.frame, becomes.attributes.frame),
	(was, becomes) => was.attributes.role !== null && was.attributes.role === becomes.attributes.role,
	(was, becomes) => was.attributes.path !== null && becomes.attributes.path !== null,
];

/**
 * The boxes of `before` taken for boxes of `after`, as pairs of an index in
 * each, matched as a set rather than in order: each way of `BOX_MATCHINGS`
 * in turn, each box of `before` taking the first of `after` left that it
 * matches. A single box left on each side, both saying something, is one box
 * moved and reworded.
 */
function boxPairs(before: readonly Node[], after: readonly Node[]): [number, number][] {
	const [was, becomes] = [before.map(boxKeys), after.map(boxKeys)];
	const pairs = new Map<number, number>();
	const taken = new Set<number>();
	for (const matching of BOX_MATCHINGS) {
		was.forEach((box, index) => {
			if (pairs.has(index)) return;
			const match = becomes.findIndex(
				(other, otherIndex) => !taken.has(otherIndex) && matching(box, other),
			);
			if (match === -1) return;
			pairs.set(index, match);
			taken.add(match);
		});
	}
	const leftWas = was.flatMap((box, index) => (pairs.has(index) ? [] : [{ box, index }]));
	const leftBecomes = becomes.flatMap((box, index) => (taken.has(index) ? [] : [{ box, index }]));
	const [onlyWas] = leftWas;
	const [onlyBecomes] = leftBecomes;
	if (
		leftWas.length === 1 &&
		leftBecomes.length === 1 &&
		onlyWas &&
		onlyBecomes &&
		onlyWas.box.saying !== "" &&
		onlyBecomes.box.saying !== ""
	) {
		pairs.set(onlyWas.index, onlyBecomes.index);
	}
	return [...pairs].toSorted(([one], [other]) => one - other);
}

/**
 * `before` and `after` in steps, matched by `pairs`: those of the pairs that
 * keep their order, the most of them that do, each a step, and every other
 * block removed or added where it stands.
 */
function stepsOf(
	before: readonly Node[],
	after: readonly Node[],
	pairs: readonly (readonly [number, number])[],
): Step[] {
	const inOrder = longestCommon(
		pairs,
		pairs.toSorted(([, one], [, other]) => one - other),
		(one, other) => one === other,
	).map(([index]) => pairs[index] as readonly [number, number]);
	const steps: Step[] = [];
	let [from, fromAfter] = [0, 0];
	for (const [index, indexAfter] of [...inOrder, [before.length, after.length] as const]) {
		steps.push(...before.slice(from, index).map((was) => ({ was })));
		steps.push(...after.slice(fromAfter, indexAfter).map((becomes) => ({ becomes })));
		const [was, becomes] = [before[index], after[indexAfter]];
		if (was && becomes) steps.push({ was, becomes });
		[from, fromAfter] = [index + 1, indexAfter + 1];
	}
	return steps;
}

/**
 * `before` matched up with `after`, in order. Those matched the strictest
 * way are matched first; between those, the next way, and so on. What is
 * left is removed and added.
 */
function alignedInOrder<T>(
	before: readonly T[],
	after: readonly T[],
	[matching, ...looser]: readonly Matching<T>[],
): { was?: T; becomes?: T }[] {
	if (!matching) {
		return [...before.map((was) => ({ was })), ...after.map((becomes) => ({ becomes }))];
	}
	const steps: { was?: T; becomes?: T }[] = [];
	let from = 0;
	let fromAfter = 0;
	for (const [index, indexAfter] of [
		...longestCommon(before, after, matching),
		[before.length, after.length] as const,
	]) {
		steps.push(
			...alignedInOrder(before.slice(from, index), after.slice(fromAfter, indexAfter), looser),
		);
		const [was, becomes] = [before[index], after[indexAfter]];
		if (was !== undefined && becomes !== undefined) steps.push({ was, becomes });
		from = index + 1;
		fromAfter = indexAfter + 1;
	}
	return steps;
}

/** The longest run of pairs, in order, that `same` holds for: the index of each in `left` and in `right`. */
function longestCommon<Left, Right>(
	left: readonly Left[],
	right: readonly Right[],
	same: (left: Left, right: Right) => boolean,
): (readonly [number, number])[] {
	// lengths[i][j] is the longest run within left[i..] and right[j..].
	const lengths = Array.from({ length: left.length + 1 }, () =>
		new Array<number>(right.length + 1).fill(0),
	);
	const at = (i: number, j: number) => lengths[i]?.[j] ?? 0;
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			const row = lengths[i] as number[];
			row[j] = same(left[i] as Left, right[j] as Right)
				? at(i + 1, j + 1) + 1
				: Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	const pairs: (readonly [number, number])[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (same(left[i] as Left, right[j] as Right)) pairs.push([i++, j++]);
		else if (at(i + 1, j) >= at(i, j + 1)) i++;
		else j++;
	}
	return pairs;
}
