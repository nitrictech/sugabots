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
	suggestionsAsAttributes,
} from "@sugabots/contracts/live-document";
import {
	liveDocumentFromText,
	liveDocumentKind,
	readLiveDocumentText,
	textOfLiveDocument,
} from "@sugabots/contracts/live-document-text";
import { boxAttributesOf, SLIDE, SLIDE_BOX } from "@sugabots/contracts/live-slides";
import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import { Fragment, Mark, type Node, Slice } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { type Mappable, Transform } from "@tiptap/pm/transform";
import { readHtml } from "./html-reader.ts";

/*
 * An agent's change to a live document. The agent reads the document as its
 * text (`textForAgents`), a document's markdown or a deck's HTML, and writes
 * the text it should read as instead. `changedTo` applies only what the agent
 * changed in that text: everything else stays as the document holds it,
 * which may be more than its text says. The difference is found block by
 * block, then word by word, and only that much is changed, so what people are
 * typing elsewhere, and the suggestions waiting there, are left alone.
 *
 * What it changes in the words, and the blocks, boxes and slides it adds or
 * removes, is either made, or handed to the suggesting library to write into
 * the document as a suggestion, exactly as it writes a person's. What it
 * changes in how a deck looks is made at once either way: where its boxes
 * are and how they and its slides are drawn (`isDesignAttribute`), and how
 * its text is styled (`TEXT_STYLE`).
 */

/** How a change is made: at once, or as the suggestion with this id. */
export type ChangeAs = "edit" | { suggestionId: string };

/**
 * Why a change can't be made as asked, in which case none of it is made:
 * `unmarkable` when it was to be a suggestion, and it changes text that can't
 * carry a suggestion's marks, as a code block's can't.
 */
export type Blocked = "unmarkable";

/**
 * Why the text an agent wrote can't be what the document reads as, in which
 * case nothing is changed: a deck's HTML that holds no slide and nothing a
 * slide could (`saysNothing`), as a deck always has a slide and HTML only
 * says none by mistake; or one that can't be read whole (see
 * `DeckUnreadable`). A document's markdown always reads as a document.
 */
export type TextRefused = "saysNothing" | DeckUnreadable;

/** An agent's change as made: the document after it, and whether any of it waits in it as a suggestion. */
export interface Changed {
	readonly document: Node;
	readonly suggested: boolean;
}

/** The document as people see it until somebody accepts a suggestion pending in it: every pending suggestion left out. */
export function withoutSuggestions(document: Node): Node {
	return plain(reverted(document));
}

/**
 * The document as an agent reads it, and changes it with `changedTo`: as its
 * text (see `textOfLiveDocument`), without its pending suggestions.
 */
export const textForAgents = (document: Node): string =>
	textOfLiveDocument(withoutSuggestions(document));

/**
 * `live` changed as an agent asks, by writing `wanted` in place of the text
 * it read, `textForAgents(live)`. What it left as it read it stays as `live`
 * holds it; what it changed is made to read, pending suggestions aside, as
 * `wanted` says, made `as` asked, but for how a deck looks, which is made at
 * once. `unchanged` when that is nothing. A `Blocked` reason when the change
 * can't be made as asked, and a `TextRefused` one when `wanted` can't be what
 * the document reads as.
 */
export function changedTo(
	live: Node,
	wanted: string,
	as: ChangeAs,
): Changed | "unchanged" | Blocked | TextRefused {
	const kind = liveDocumentKind(live);
	const reading = readLiveDocumentText(kind, wanted, readHtml);
	if (reading.outcome === "nothing") return "saysNothing";
	if (reading.outcome === "unreadable") return reading.reason;
	const revert = reverted(live);
	const before = plain(revert);
	// The document's own text always reads back as a document of its kind.
	const shown = liveDocumentFromText(kind, textOfLiveDocument(before), readHtml);
	const target = withChangesOf(before, shown, reading.document);
	const found: Found = { replacements: [], attributes: [], restyles: [], unmarkable: false };
	findDifferences(before, target, 0, found);
	const { replacements, attributes, restyles } = found;
	if (replacements.length === 0 && attributes.length === 0 && restyles.length === 0) {
		return "unchanged";
	}
	if (as !== "edit" && found.unmarkable) return "unmarkable";
	// The differences are places in the document without its suggestions, so each is found in the live one.
	const inLive = revert.mapping.invert();
	// How a deck looks changes at once, however its words do. That moves nothing, so every place found stays where it is.
	const change = new Transform(live);
	for (const { at, name, value } of attributes) {
		change.setNodeAttribute(inLive.map(at, 1), name, value);
	}
	for (const restyle of restyles) setTextStyle(change, restyle, inLive);
	if (as === "edit" || replacements.length === 0) {
		return { document: replaced(change, replacements, inLive).doc, suggested: false };
	}
	const designed = EditorState.create({ doc: change.doc, plugins: [suggestChanges()] });
	const state = designed.apply(designed.tr.setMeta(suggestChangesKey, { enabled: true }));
	const words = replaced(state.tr, replacements, inLive);
	const suggestion = transformToSuggestionTransaction(words, state, () => as.suggestionId);
	return { document: suggestion.doc, suggested: true };
}

/**
 * `change` with each replacement made, found in the live document by
 * `inLive`: from the end, so a replacement never moves the places still to
 * be replaced.
 */
function replaced<T extends Transform>(
	change: T,
	replacements: readonly Replacement[],
	inLive: Mappable,
): T {
	for (const { from, to, slice } of replacements.toReversed()) {
		// Stopping short of what somebody proposes adding at either edge, which is theirs to settle.
		const start = inLive.map(from, 1);
		change.replace(start, Math.max(start, inLive.map(to, -1)), slice);
	}
	return change;
}

/** Gives the stretch of text `restyle` says, found in the live document by `inLive`, the text style it says. */
function setTextStyle(change: Transform, { from, to, style }: Restyle, inLive: Mappable): void {
	const [start, end] = [inLive.map(from, 1), inLive.map(to, -1)];
	const textStyle = change.doc.type.schema.marks[TEXT_STYLE];
	if (!textStyle || end <= start) return;
	change.removeMark(start, end, textStyle);
	if (style) change.addMark(start, end, style);
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
	/** Changes to how a deck looks, made at once (see `isDesignAttribute`). */
	attributes: AttributeChange[];
	/** Changes to how a deck's text is styled, made at once. */
	restyles: Restyle[];
	/** Whether a replacement is inside text that can't carry a suggestion's marks. */
	unmarkable: boolean;
}

const isSlide = (node: Node) => node.type.name === SLIDE;

const isBox = (node: Node) => node.type.name === SLIDE_BOX;

/** The attributes of a paragraph or heading that say how a deck's text looks (see `slide-text-style.ts`). */
const LINE_DESIGN_ATTRIBUTES: ReadonlySet<string> = new Set(["textAlign", "lineHeight"]);

/**
 * Whether `name` is an attribute of `node` that says how a deck looks, which
 * an agent's change sets at once rather than suggesting: any of a slide's and
 * a box's, which say where a box is and how it and its slide are drawn, and a
 * line's alignment and line height.
 */
const isDesignAttribute = (node: Node, name: string) =>
	isSlide(node) || isBox(node) || LINE_DESIGN_ATTRIBUTES.has(name);

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
function findDifferences(before: Node, after: Node, start: number, found: Found): void {
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
				if (was.isTextblock) findTextDifference(was, becomes, position + 1, found);
				else findDifferences(was, becomes, position + 1, found);
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
 * them, and the text styles that differ around them. Whole words, so a
 * suggestion reads as "~~Friday~~ Monday" and not "~~Fri~~Mon". A word
 * differs when its text, its marks or an image in it does, so a change that
 * only marks a word, or swaps an image, is found too; but a change of its
 * text style alone is a restyle, made at once. `start` is where the line's
 * text begins in the document.
 */
function findTextDifference(before: Node, after: Node, start: number, found: Found): void {
	const [was, becomes] = [lineOf(before), lineOf(after)];
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

/** Whether two places hold the same, their text styles aside, which a restyle changes. */
const samePlace = (one: Place | undefined, other: Place | undefined) =>
	one !== undefined &&
	other !== undefined &&
	one.character === other.character &&
	Mark.sameSet(withoutTextStyle(one.marks), withoutTextStyle(other.marks)) &&
	(one.node && other.node
		? one.node.mark(Mark.none).eq(other.node.mark(Mark.none))
		: one.node === other.node);

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

/** Whether two blocks are taken for the same one, one way of matching them. */
type Matching = (was: Node, becomes: Node) => boolean;

/** What a box says: its words, and each image in it as its address. */
const sayingOf = (box: Node) =>
	box.textBetween(0, box.content.size, "\n", (leaf) =>
		leaf.type.name === "image" ? `[${String(leaf.attrs.src)}]` : "",
	);

/**
 * The ways two of a slide's boxes are taken for the same box, strictest
 * first, as an agent may move, restyle and reword a box, and add and remove
 * others beside it. Boxes matched no way are removed and added.
 */
const BOX_MATCHINGS: readonly Matching[] = [
	// Saying the same, as a box moved or restyled.
	(was, becomes) => sayingOf(was) !== "" && sayingOf(was) === sayingOf(becomes),
	// Where it was, as a box reworded.
	(was, becomes) => isDeepStrictEqual(boxAttributesOf(was).frame, boxAttributesOf(becomes).frame),
	// For the same thing, as a title moved and reworded.
	(was, becomes) => {
		const { role } = boxAttributesOf(was);
		return role !== null && role === boxAttributesOf(becomes).role;
	},
	// Saying nothing, as a shape moved or restyled.
	(was, becomes) => sayingOf(was) === "" && sayingOf(becomes) === "",
];

/**
 * The ways blocks are matched, strictest first. Those that read the same;
 * then slides with the same title, so a slide added beside one that changed
 * isn't taken for it; then boxes, as `BOX_MATCHINGS` matches them; then any
 * other blocks of one kind, so a paragraph is compared with a paragraph and
 * never with the list beside it.
 */
const MATCHINGS: readonly Matching[] = [
	(was, becomes) => was.eq(becomes),
	(was, becomes) => isSlide(was) && isSlide(becomes) && titleOf(was) === titleOf(becomes),
	...BOX_MATCHINGS.map(
		(matching): Matching =>
			(was, becomes) =>
				isBox(was) && isBox(becomes) && matching(was, becomes),
	),
	(was, becomes) => !isBox(was) && (was.sameMarkup(becomes) || comparedInside(was, becomes)),
];

/** A slide's title: the words of the first line in it. */
function titleOf(slide: Node): string {
	let title: string | undefined;
	slide.descendants((node) => {
		if (title === undefined && node.isTextblock) title = node.textContent;
		return title === undefined;
	});
	return title ?? "";
}

/**
 * `before` matched up with `after`, in order. Blocks matched the strictest
 * way are matched first; between those, the next way, and so on. What is left
 * is removed and added.
 */
function aligned(
	before: readonly Node[],
	after: readonly Node[],
	[matching, ...looser]: readonly Matching[] = MATCHINGS,
): Step[] {
	if (!matching) {
		return [...before.map((was) => ({ was })), ...after.map((becomes) => ({ becomes }))];
	}
	const steps: Step[] = [];
	let from = 0;
	let fromAfter = 0;
	for (const [index, indexAfter] of [
		...longestCommon(before, after, matching),
		[before.length, after.length] as const,
	]) {
		steps.push(...aligned(before.slice(from, index), after.slice(fromAfter, indexAfter), looser));
		const [was, becomes] = [before[index], after[indexAfter]];
		if (was && becomes) steps.push({ was, becomes });
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
