import {
	revertSuggestions,
	suggestChanges,
	suggestChangesKey,
	transformToSuggestionTransaction,
} from "@handlewithcare/prosemirror-suggest-changes";
import {
	holdsSuggestion,
	NODE_SUGGESTION,
	SUGGESTED_INSERTION,
	SUGGESTED_MODIFICATION,
	suggestionsAsAttributes,
} from "@sugabots/contracts/live-document";
import {
	liveDocumentFromMarkdown,
	liveDocumentKind,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import { fitSlideBody, layoutOf, SLIDE } from "@sugabots/contracts/live-slides";
import { Fragment, Mark, type Node, Slice } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";

/*
 * An agent's change to a live document. The agent reads the document as
 * markdown, as it reads without the suggestions pending in it, and writes
 * what it should read instead. Only what the agent changed in that markdown
 * is applied: everything else stays as the document holds it, which may be
 * more than its markdown says. The difference is worked out block by block,
 * then word by word, and only that much is changed, so what people are
 * typing elsewhere and the suggestions waiting there are left alone. The
 * change is either made, or handed to the suggesting library to write into
 * the document as a suggestion, exactly as it writes a person's.
 */

/** How a change is made: at once, or as the suggestion with this id. */
export type ChangeAs = "edit" | { suggestionId: string };

/**
 * Why a change can't be made as asked, in which case none of it is made:
 *
 * - `unmarkable`: it was to be a suggestion, and it is inside text that can't
 *   carry a suggestion's marks, as a code block's can't.
 * - `layoutPending`: it changes or removes a slide while a new layout
 *   suggested for that slide waits. Until somebody settles that suggestion,
 *   the slide holds its blocks as they are and as the new layout moves them,
 *   one copy proposed for removal and the other for adding, so a change to
 *   its words would be made to one copy and lost when the suggestion went the
 *   other way; and its suggestion's mark keeps the layout to go back to, so
 *   it has no layout of its own to change.
 * - `suggestionPending`: it changes the layout of a slide holding a
 *   suggestion. A new layout replaces the blocks it moves, so a suggestion in
 *   one of them would be lost. People are held to the same rule in the
 *   editor.
 */
export type Blocked = "unmarkable" | "layoutPending" | "suggestionPending";

/** The document as it reads with every pending suggestion left out. */
export function withoutSuggestions(document: Node): Node {
	return plain(reverted(document));
}

/** The document as an agent reads it, and changes it with `changedTo`: as markdown, without its pending suggestions. */
export const markdownWithoutSuggestions = (document: Node): string =>
	markdownOfLiveDocument(withoutSuggestions(document));

/**
 * `live` changed as an agent asks, by writing `wanted` in place of the
 * markdown it read, `markdownWithoutSuggestions(live)`. What it left as it
 * read it stays as `live` holds it; what it changed is made to read, pending
 * suggestions aside, as `wanted` says. `unchanged` when that is nothing. A
 * `Blocked` reason when the change can't be made as asked.
 */
export function changedTo(live: Node, wanted: string, as: ChangeAs): Node | "unchanged" | Blocked {
	const revert = reverted(live);
	const before = plain(revert);
	const read = (markdown: string) => liveDocumentFromMarkdown(liveDocumentKind(live), markdown);
	// The markdown the agent read is `before`'s, as `markdownWithoutSuggestions` writes it.
	const target = withChangesOf(before, read(markdownOfLiveDocument(before)), read(wanted));
	const found: Found = { replacements: [], attributes: [], slides: [], unmarkable: false };
	findDifferences(before, target, 0, found);
	if (found.replacements.length === 0 && found.attributes.length === 0) return "unchanged";
	if (as !== "edit" && found.unmarkable) return "unmarkable";
	// The differences are places in the document without its suggestions, so each is found in the live one.
	const inLive = revert.mapping.invert();
	const blocked = blockedBySlide(live, found, inLive);
	if (blocked) return blocked;
	const attributes = found.attributes.map((change) => ({
		...change,
		at: inLive.map(change.at, 1),
	}));

	const suggesting = EditorState.create({ doc: live, plugins: [suggestChanges()] });
	const state =
		as === "edit"
			? suggesting
			: suggesting.apply(suggesting.tr.setMeta(suggestChangesKey, { enabled: true }));
	const change = state.tr;
	// First, as changing an attribute moves nothing still to be changed.
	for (const { at, name, value } of attributes) change.setNodeAttribute(at, name, value);
	// From the end, so a change never moves the places still to be changed.
	for (const { from, to, slice } of found.replacements.toReversed()) {
		// Stopping short of what somebody proposes adding at either edge, which is theirs to settle.
		const start = inLive.map(from, 1);
		change.replace(start, Math.max(start, inLive.map(to, -1)), slice);
	}
	if (as === "edit") return change.doc;
	return transformToSuggestionTransaction(change, state, () => as.suggestionId).doc;
}

/**
 * Why the change can't touch one of the slides it changes or removes, found
 * in `live` by `inLive`, if it can't (see `Blocked`).
 */
function blockedBySlide(live: Node, found: Found, inLive: Mappable): Blocked | undefined {
	for (const at of found.slides) {
		const slide = live.nodeAt(inLive.map(at, 1));
		if (!slide) continue;
		if (hasSuggestedAttribute(slide, LAYOUT)) return "layoutPending";
		const relaidOut = found.attributes.some((change) => change.at === at && change.name === LAYOUT);
		if (relaidOut && holdsSuggestion(slide)) return "suggestionPending";
	}
	return undefined;
}

/** The attribute a slide's layout is in. */
const LAYOUT = "layout";

/**
 * `before` with the changes an agent made, and no others. The agent read
 * `before` as markdown, which `shown` is read back from, and wrote the
 * markdown `wanted` is read from. Wherever `wanted` holds what `shown` does,
 * `before`'s own blocks stay, so what markdown can't say about them, such as
 * spaces at the end of a slide's notes, is never lost to a change made
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
			shown.attrs[name] === value ? before.attrs[name] : value,
		]),
	);
	const changed = before.type.create(attributes, content, before.marks);
	return changed.type.name === SLIDE ? withBodyFitted(changed) : changed;
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
 * their markdown. Mostly one block each; but reading markdown back may join
 * two blocks into one, as two lists side by side, or make none of a block,
 * so a run is what stands between blocks that read back as they were.
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

/** The slide with its frame holding what its layout says, as every slide read from markdown does. */
function withBodyFitted(slide: Node): Node {
	const body = slide.child(0);
	const fitted = fitSlideBody(body, layoutOf(slide));
	return fitted === body ? slide : slide.copy(slide.content.replaceChild(0, fitted));
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

interface Found {
	replacements: Replacement[];
	attributes: AttributeChange[];
	/** Where each slide that changes, or is removed, starts. */
	slides: number[];
	/** Whether a difference is inside text that can't carry a suggestion's marks. */
	unmarkable: boolean;
}

/**
 * Whether `node` is suggested a new value for its attribute `name` already,
 * which it holds, keeping the value it would replace in the suggestion's mark.
 */
const hasSuggestedAttribute = (node: Node | null, name: string) =>
	node?.marks.some(
		(mark) => mark.type.name === SUGGESTED_MODIFICATION && mark.attrs.attrName === name,
	) ?? false;

/**
 * Whether a node keeps its place when its attributes change, so that it is
 * compared inside and its attributes changed, as a slide is when its layout
 * changes. The blocks the new layout leaves where they are, such as the
 * slide's title, are kept, with what somebody is typing in them, and a
 * suggestion shows the new layout over what the slide holds rather than a
 * whole slide removed and another added. The blocks it moves are replaced,
 * which a suggestion in one wouldn't survive (see `Blocked`). Any other node
 * whose attributes change, as a heading's level, is replaced.
 */
const keepsPlaceWhenAttributesChange = (node: Node) => node.type.name === SLIDE;

/** Whether `was` and `becomes` are compared inside, rather than one replacing the other. */
const comparedInside = (was: Node, becomes: Node) =>
	!was.isLeaf &&
	(was.sameMarkup(becomes) || (was.type === becomes.type && keepsPlaceWhenAttributesChange(was)));

/** The attributes `becomes` has that `was`, at `at`, doesn't, but for what is suggested for it. */
const attributeChanges = (was: Node, becomes: Node, at: number): AttributeChange[] =>
	Object.entries(becomes.attrs)
		.filter(([name, value]) => name !== NODE_SUGGESTION && was.attrs[name] !== value)
		.map(([name, value]) => ({ at, name, value }));

/**
 * Adds to `found` what must be replaced for `before`'s children to read as
 * `after`'s do. A child that reads the same is left, one of the same kind is
 * compared inside, and the rest are removed or added, a run at a time.
 * `start` is where `before`'s content begins in the document.
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
		const slideChanges = was?.type.name === SLIDE && !(becomes && was.eq(becomes));
		if (slideChanges) found.slides.push(position);
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
 * Adds to `found` the words of a paragraph that differ and the words that
 * replace them. Whole words, so a suggestion reads as "~~Friday~~ Monday" and
 * not "~~Fri~~Mon". A word differs when its text, its marks or an image in it
 * does, so a change that only marks a word, or swaps an image, is found too.
 * `start` is where the paragraph's text begins in the document.
 */
function findTextDifference(before: Node, after: Node, start: number, found: Found): void {
	const [was, becomes] = [lineOf(before), lineOf(after)];
	const shorter = Math.min(was.length, becomes.length);
	let same = 0;
	while (same < shorter && samePlace(was[same], becomes[same])) same++;
	while (same > 0 && !isSpace(was[same - 1])) same--;
	let sameAtEnd = 0;
	while (
		sameAtEnd < shorter - same &&
		samePlace(was.at(-1 - sameAtEnd), becomes.at(-1 - sameAtEnd))
	) {
		sameAtEnd++;
	}
	while (sameAtEnd > 0 && !isSpace(was.at(-sameAtEnd))) sameAtEnd--;
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

const samePlace = (one: Place | undefined, other: Place | undefined) =>
	one !== undefined &&
	other !== undefined &&
	one.character === other.character &&
	Mark.sameSet(one.marks, other.marks) &&
	(one.node && other.node ? one.node.eq(other.node) : one.node === other.node);

const isSpace = (place: Place | undefined) => place !== undefined && /\s/.test(place.character);

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

/**
 * The ways blocks are matched, strictest first. Those that read the same; then
 * slides with the same title, so a slide added beside one that changed isn't
 * taken for it; then blocks of the same kind, so a paragraph is compared with
 * a paragraph and never with the list beside it.
 */
const MATCHINGS: readonly Matching[] = [
	(was, becomes) => was.eq(becomes),
	(was, becomes) =>
		was.type.name === SLIDE && was.type === becomes.type && titleOf(was) === titleOf(becomes),
	(was, becomes) =>
		was.sameMarkup(becomes) || (was.type === becomes.type && keepsPlaceWhenAttributesChange(was)),
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
