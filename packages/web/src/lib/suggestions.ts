import { applySuggestion, revertSuggestion } from "@handlewithcare/prosemirror-suggest-changes";
import {
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	type SuggestionBy,
	suggestionBy,
} from "@sugabots/contracts/live-document";
import type { Node } from "@tiptap/pm/model";
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
			// A block marked whole carries the mark itself, and its text carries none.
			const text = (node.isText ? (node.text ?? "") : node.textContent).replaceAll(UNSEEN, "");
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
			});
		}
	});
	return [...pending.values()];
}

/**
 * Settles a suggestion. Accepting it removes what it proposed removing and
 * keeps what it proposed adding as ordinary content; rejecting it does the reverse.
 */
export const settling = (suggestionId: string, how: "accept" | "reject"): Command =>
	how === "accept" ? applySuggestion(suggestionId) : revertSuggestion(suggestionId);

/** The marks a suggestion puts on content: adding it, removing it, or changing its kind or formatting. */
const SUGGESTION_MARKS = new Set([SUGGESTED_INSERTION, SUGGESTED_DELETION, "modification"]);

/** The character the suggesting library puts where a block was split or joined, which nobody sees. */
const UNSEEN = "​";

/** Text from separate places reads as separate words. */
const joined = (text: string, more: string) => (text && more ? `${text} ${more}` : text || more);
