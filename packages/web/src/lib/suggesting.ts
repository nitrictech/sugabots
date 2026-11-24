import { suggestChanges, withSuggestChanges } from "@handlewithcare/prosemirror-suggest-changes";
import {
	marksOfNodeSuggestion,
	NODE_SUGGESTION,
	nodeSuggestion,
	saysNodeSuggestion,
	suggestionId,
} from "@sugabots/contracts/live-document";
import { type Editor, Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
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
		// Not a change of the person's own to undo.
		return inStep.docChanged ? inStep.setMeta("addToHistory", false) : null;
	},
});

/** The key the sync layer marks a transaction with, saying whether the change came from somebody else. */
const FROM_SYNC = "y-sync$";

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
