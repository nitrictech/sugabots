import {
	revertSuggestions,
	suggestChanges,
	suggestChangesKey,
	transformToSuggestionTransaction,
} from "@handlewithcare/prosemirror-suggest-changes";
import { SUGGESTED_INSERTION, suggestionsAsAttributes } from "@sugabots/contracts/live-document";
import { Fragment, type Node, Slice } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";

/*
 * An agent's change to a live document. The agent works on the document as
 * it reads without the suggestions pending in it, and says what it should
 * read instead. The difference is worked out block by block, then word by
 * word, and only that much is changed, so what people are typing elsewhere
 * and the suggestions waiting there are left alone. The change is either
 * made, or handed to the suggesting library to write into the document as a
 * suggestion, exactly as it writes a person's.
 */

/** How a change is made: at once, or as the suggestion with this id. */
export type ChangeAs = "edit" | { suggestionId: string };

/** Why a change can't be shown as a suggestion: it is inside text that can't be marked, as a code block's can't. */
export type Blocked = "unmarkable";

/** The document as it reads with every pending suggestion left out. */
export function withoutSuggestions(document: Node): Node {
	return plain(reverted(document));
}

/**
 * `live` changed so that, suggestions aside, it reads as `wanted` does.
 * `unchanged` when it already does. A `Blocked` reason when the change was to
 * be a suggestion and can't be shown as one.
 */
export function changedTo(live: Node, wanted: Node, as: ChangeAs): Node | "unchanged" | Blocked {
	const revert = reverted(live);
	const found: Found = { replacements: [], unmarkable: false };
	findDifferences(plain(revert), wanted, 0, found);
	if (found.replacements.length === 0) return "unchanged";
	if (as !== "edit" && found.unmarkable) return "unmarkable";

	const suggesting = EditorState.create({ doc: live, plugins: [suggestChanges()] });
	const state =
		as === "edit"
			? suggesting
			: suggesting.apply(suggesting.tr.setMeta(suggestChangesKey, { enabled: true }));
	// The differences are places in the document without its suggestions, so each is found in the live one.
	const inLive = revert.mapping.invert();
	const change = state.tr;
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

interface Found {
	replacements: Replacement[];
	/** Whether a difference is inside text that can't carry a suggestion's marks. */
	unmarkable: boolean;
}

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
		if (was && becomes && was.sameMarkup(becomes) && !was.isLeaf) {
			endRun();
			if (!was.eq(becomes)) {
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
 * not "~~Fri~~Mon". `start` is where the paragraph's text begins in the document.
 */
function findTextDifference(before: Node, after: Node, start: number, found: Found): void {
	const [was, becomes] = [textOf(before), textOf(after)];
	const shorter = Math.min(was.length, becomes.length);
	let same = 0;
	while (same < shorter && was[same] === becomes[same]) same++;
	while (same > 0 && !isSpace(was[same - 1])) same--;
	let sameAtEnd = 0;
	while (sameAtEnd < shorter - same && was.at(-1 - sameAtEnd) === becomes.at(-1 - sameAtEnd)) {
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

/** Stands for anything in a line that isn't text, so an offset into the text is a position in the line. */
const NOT_TEXT = "￼";

const textOf = (textblock: Node) =>
	textblock.textBetween(0, textblock.content.size, undefined, NOT_TEXT);

const isSpace = (character: string | undefined) => character !== undefined && /\s/.test(character);

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

/**
 * `before` matched up with `after`, in order. Blocks that read the same are
 * matched first; between those, blocks of the same kind are matched, so a
 * paragraph is compared with a paragraph and never with the list beside it.
 */
function aligned(before: readonly Node[], after: readonly Node[]): Step[] {
	const steps: Step[] = [];
	let block = 0;
	let node = 0;
	const identical = longestCommon(before, after, (was, becomes) => was.eq(becomes));
	for (const [sameBlock, sameNode] of [...identical, [before.length, after.length] as const]) {
		const [between, betweenAfter] = [before.slice(block, sameBlock), after.slice(node, sameNode)];
		let from = 0;
		let fromAfter = 0;
		const alike = longestCommon(between, betweenAfter, (was, becomes) => was.sameMarkup(becomes));
		for (const [alikeBlock, alikeNode] of [
			...alike,
			[between.length, betweenAfter.length] as const,
		]) {
			steps.push(...between.slice(from, alikeBlock).map((was) => ({ was })));
			steps.push(...betweenAfter.slice(fromAfter, alikeNode).map((becomes) => ({ becomes })));
			const [was, becomes] = [between[alikeBlock], betweenAfter[alikeNode]];
			if (was && becomes) steps.push({ was, becomes });
			from = alikeBlock + 1;
			fromAfter = alikeNode + 1;
		}
		const [was, becomes] = [before[sameBlock], after[sameNode]];
		if (was && becomes) steps.push({ was, becomes });
		block = sameBlock + 1;
		node = sameNode + 1;
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
