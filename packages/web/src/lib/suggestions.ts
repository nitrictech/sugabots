import { applySuggestion, revertSuggestion } from "@handlewithcare/prosemirror-suggest-changes";
import {
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	SUGGESTED_MODIFICATION,
	type SuggestionBy,
	suggestionBy,
} from "@sugabots/contracts/live-document";
import { SLIDE } from "@sugabots/contracts/live-slides";
import { isSlideLayout, type SlideLayout } from "@sugabots/contracts/slide-layouts";
import type { Mark, Node } from "@tiptap/pm/model";
import type { Command } from "@tiptap/pm/state";

/*
 * The suggestions in a live document, for the person deciding on them. A
 * suggestion is content marked in the document: what it would remove, still
 * there, and what it would add, not yet part of it. People make them by
 * editing in suggesting mode, and the API writes a bot's the same way
 * (`artifacts/suggestions.ts` in core).
 */

/** A suggestion waiting in the document: who made it, what it would remove and add, and where it is. */
export interface PendingSuggestion {
	id: string;
	by: SuggestionBy;
	removes: string;
	adds: string;
	/** Where its marked content starts and ends in the document. */
	from: number;
	to: number;
	/** What it would do to a deck's slides themselves, when it does anything to them. */
	slides?: SlideChanges;
}

/** What a suggestion would do to whole slides of a deck: add one, remove one, or lay one out anew. */
export interface SlideChanges {
	adds: boolean;
	removes: boolean;
	/** The layout it would give a slide. */
	layout: SlideLayout | undefined;
}

/** The suggestions waiting in the document, in the order they appear. */
export function pendingSuggestions(document: Node): PendingSuggestion[] {
	const pending = new Map<string, PendingSuggestion>();
	document.descendants((node, position) => {
		for (const mark of node.marks) {
			if (!SUGGESTION_MARKS.has(mark.type.name)) continue;
			const id = String(mark.attrs.id);
			const suggestion = pending.get(id) ?? {
				id,
				by: suggestionBy(id),
				removes: "",
				adds: "",
				from: position,
				to: position,
			};
			// A block or image marked whole carries the mark itself, and its text carries none.
			const text = wordsOf(node).replaceAll(UNSEEN, "");
			pending.set(id, {
				...suggestion,
				removes:
					mark.type.name === SUGGESTED_DELETION
						? joined(suggestion.removes, text)
						: suggestion.removes,
				adds:
					mark.type.name === SUGGESTED_INSERTION ? joined(suggestion.adds, text) : suggestion.adds,
				from: Math.min(suggestion.from, position),
				to: Math.max(suggestion.to, position + node.nodeSize),
				...(node.type.name === SLIDE ? { slides: slideChanges(suggestion.slides, mark) } : {}),
			});
		}
	});
	return [...pending.values()];
}

/** `changes` with what `mark`, on a slide, adds to them. */
function slideChanges(changes: SlideChanges | undefined, mark: Mark): SlideChanges {
	const { adds, removes, layout } = changes ?? { adds: false, removes: false, layout: undefined };
	const laidOut: unknown = mark.attrs.attrName === "layout" ? mark.attrs.newValue : undefined;
	return {
		adds: adds || mark.type.name === SUGGESTED_INSERTION,
		removes: removes || mark.type.name === SUGGESTED_DELETION,
		layout: isSlideLayout(laidOut) ? laidOut : layout,
	};
}

/**
 * Settles the suggestion `suggestionId`, leaving every other one waiting as
 * it is. Accepting it removes what it proposed removing and keeps what it
 * proposed adding as ordinary content, and keeps the kind it proposed for a
 * block or the layout for a slide; rejecting it does the reverse. Settling is
 * never itself a suggestion, even in suggesting mode.
 *
 * The suggesting library is patched (`patches/` at the repository root) so
 * that it settles only this suggestion's changes to blocks and slides: as
 * published, it settles everyone's alongside, and rejects nothing that adds
 * or removes no content.
 */
export const settlingSuggestion = (suggestionId: string, how: "accept" | "reject"): Command =>
	how === "accept" ? applySuggestion(suggestionId) : revertSuggestion(suggestionId);

/** The marks a suggestion puts on content: adding it, removing it, or changing its kind or formatting. */
const SUGGESTION_MARKS = new Set([SUGGESTED_INSERTION, SUGGESTED_DELETION, SUGGESTED_MODIFICATION]);

/** The character the suggesting library puts where a block was split or joined, which nobody sees. */
const UNSEEN = "​";

/**
 * What a node says, as a suggestion's card puts it: its text, with a block's
 * lines and a table's cells apart, and an image's words for what it shows.
 */
function wordsOf(node: Node): string {
	if (node.isText) return node.text ?? "";
	if (node.isLeaf) return typeof node.attrs.alt === "string" ? node.attrs.alt : "";
	return node.textBetween(0, node.content.size, " ", wordsOf);
}

/** Text from separate places reads as separate words. */
const joined = (text: string, more: string) => (text && more ? `${text} ${more}` : text || more);
