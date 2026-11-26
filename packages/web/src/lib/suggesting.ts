import {
	isSuggestChangesEnabled,
	suggestChanges,
	suggestChangesKey,
	transformToSuggestionTransaction,
	withSuggestChanges,
} from "@handlewithcare/prosemirror-suggest-changes";
import {
	marksOfNodeSuggestion,
	NODE_SUGGESTION,
	nodeSuggestion,
	saysNodeSuggestion,
	suggestionId,
} from "@sugabots/contracts/live-document";
import { type Editor, Extension } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { v4 as uuidv4 } from "uuid";

/*
 * Suggesting mode in a live document's editor: what a person does while it
 * is on is written into the document as a suggestion, for somebody to accept
 * or reject, and reaches the others in the document as one.
 */

/**
 * Keeps track of whether this person is suggesting, and turns what they do in
 * the editor into suggestions while they are. The mode is theirs alone: each
 * person in the document chooses their own.
 */
export const Suggesting = Extension.create({
	name: "suggesting",
	addProseMirrorPlugins() {
		return [suggestChanges(), nodeSuggestionsInStep];
	},
});

/**
 * Keeps each node's suggestion marks and the attribute that says them the
 * same, since only the attribute reaches the others in the document. After a
 * change made here, the attribute is written from the marks; after one that
 * arrived from elsewhere, the marks are restored from the attribute.
 */
const nodeSuggestionsInStep = new Plugin({
	appendTransaction(transactions, _before, state) {
		if (!transactions.some((transaction) => transaction.docChanged)) return null;
		const arrived = transactions.some(
			(transaction) => transaction.getMeta(FROM_SYNC)?.isChangeOrigin === true,
		);
		const inStep = state.tr;
		state.doc.descendants((node, position) => {
			if (!saysNodeSuggestion(node)) return;
			const marked = nodeSuggestion(node);
			if (marked === (node.attrs[NODE_SUGGESTION] ?? null)) return;
			if (!arrived) return void inStep.setNodeAttribute(position, NODE_SUGGESTION, marked);
			for (const mark of node.marks) inStep.removeNodeMark(position, mark);
			for (const mark of marksOfNodeSuggestion(node)) inStep.addNodeMark(position, mark);
		});
		if (!inStep.docChanged) return null;
		// Marks restored after a change from elsewhere are nobody's change here to undo. The attribute
		// written after a change made here belongs to that change and is undone with it. Marked not to
		// undo, it would keep the change itself out of undo too: the sync layer records the change and
		// this as one, undoable or not as the last transaction says.
		return arrived ? inStep.setMeta("addToHistory", false) : inStep;
	},
});

/** The key the sync layer marks a transaction with, saying whether the change came from somebody else. */
const FROM_SYNC = "y-sync$";

/**
 * Makes `change`, a change of `name`'s in several steps, such as giving a
 * slide a new layout, as one suggestion while they are suggesting, where
 * `suggestingAs` would make a suggestion of each step. So it is accepted or
 * undone whole, as the API's suggestions are. Made at once otherwise.
 */
export function dispatchAsOneChange(editor: Editor, change: Transaction, name: string): void {
	const { state, view } = editor;
	if (!isSuggestChangesEnabled(state)) {
		view.dispatch(change);
		return;
	}
	const id = suggestionId(uuidv4(), { kind: "person", name });
	view.dispatch(madeAsItIs(transformToSuggestionTransaction(change, state, () => id)));
}

/**
 * `transaction`, marked to be made as it is, even while the person is
 * suggesting, rather than turned into a suggestion (see `suggestingAs`): for
 * what nobody accepts or rejects, as where a slide's boxes sit, and for a
 * change made into one suggestion already.
 */
export const madeAsItIs = (transaction: Transaction): Transaction =>
	transaction.setMeta(suggestChangesKey, { skip: true });

/**
 * Has `editor` hand every change `name` makes to the suggesting library,
 * which turns it into a suggestion of theirs while they are in suggesting
 * mode and passes it through otherwise. Returns how to stop.
 */
export function suggestingAs(editor: Editor, name: string): () => void {
	const apply = editor.view.props.dispatchTransaction;
	editor.view.setProps({
		dispatchTransaction: withSuggestChanges(
			(transaction) => apply?.call(editor.view, transaction),
			() => suggestionId(uuidv4(), { kind: "person", name }),
		),
	});
	return () => editor.view.setProps({ dispatchTransaction: apply });
}
