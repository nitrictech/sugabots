import {
	enableSuggestChanges,
	suggestChanges,
	transformToSuggestionTransaction,
} from "@handlewithcare/prosemirror-suggest-changes";
import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { getSchema } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { pendingSuggestions, settling } from "./suggestions.ts";

const schema = getSchema(liveDocumentExtensions({ undo: false }));

const paragraph = (words: string) => schema.node("paragraph", null, [schema.text(words)]);
const document = (...blocks: Node[]) => schema.node("doc", null, blocks);

/** A document being edited by someone in suggesting mode, whose every change becomes a suggestion. */
function suggesting(doc: Node, by: string) {
	let state = EditorState.create({ doc, plugins: [suggestChanges()] });
	enableSuggestChanges(state, (transaction) => {
		state = state.apply(transaction);
	});
	let made = 0;
	return {
		get doc() {
			return state.doc;
		},
		/** Makes the change `edit` describes, as one suggestion. */
		suggest(edit: (transaction: Transaction) => Transaction) {
			const id = `s${++made}:person:${by}`;
			state = state.apply(transformToSuggestionTransaction(edit(state.tr), state, () => id));
			return id;
		},
		settle(suggestionId: string, how: "accept" | "reject") {
			settling(suggestionId, how)(state, (transaction) => {
				state = state.apply(transaction);
			});
		},
	};
}

const lines = (doc: Node) => {
	const found: string[] = [];
	doc.descendants((node) => {
		if (node.isTextblock) found.push(node.textContent);
	});
	return found;
};

describe("a suggestion, settled by a person", () => {
	const plan = () =>
		suggesting(document(paragraph("Ship on Friday."), paragraph("Tell support.")), "Kim");
	// "Friday" in the first paragraph, by position.
	const friday = { from: 9, to: 15 };

	it("lists what it would remove and add, by who suggested it", () => {
		const editing = plan();
		const id = editing.suggest((change) => change.insertText("Monday", friday.from, friday.to));

		expect(pendingSuggestions(editing.doc)).toMatchObject([
			{ id, by: { kind: "person", name: "Kim" }, removes: "Friday", adds: "Monday" },
		]);
	});

	it("becomes the document's text when accepted", () => {
		const editing = plan();
		const id = editing.suggest((change) => change.insertText("Monday", friday.from, friday.to));

		editing.settle(id, "accept");

		expect(lines(editing.doc)).toEqual(["Ship on Monday.", "Tell support."]);
		expect(pendingSuggestions(editing.doc)).toEqual([]);
	});

	it("leaves the document as it read when rejected", () => {
		const editing = plan();
		const id = editing.suggest((change) => change.insertText("Monday", friday.from, friday.to));

		editing.settle(id, "reject");

		expect(lines(editing.doc)).toEqual(["Ship on Friday.", "Tell support."]);
	});

	it("takes a proposed paragraph away whole when rejected, and keeps it when accepted", () => {
		const added = (how: "accept" | "reject") => {
			const editing = plan();
			const id = editing.suggest((change) =>
				change.insert(change.doc.content.size, paragraph("Brief sales too.")),
			);
			editing.settle(id, how);
			return lines(editing.doc);
		};

		expect(added("reject")).toEqual(["Ship on Friday.", "Tell support."]);
		expect(added("accept")).toEqual(["Ship on Friday.", "Tell support.", "Brief sales too."]);
	});

	it("takes a paragraph away once its removal is accepted", () => {
		const editing = plan();
		const second = editing.doc.child(0).nodeSize;
		const id = editing.suggest((change) => change.delete(second, change.doc.content.size));

		expect(pendingSuggestions(editing.doc)).toMatchObject([{ id, removes: "Tell support." }]);
		editing.settle(id, "accept");

		expect(lines(editing.doc)).toEqual(["Ship on Friday."]);
	});

	it("leaves other suggestions waiting", () => {
		const editing = plan();
		const first = editing.suggest((change) => change.insertText("Monday", friday.from, friday.to));
		// "support" in the second paragraph, which the first suggestion has moved along.
		const support = editing.doc.child(0).nodeSize + 1 + "Tell ".length;
		const second = editing.suggest((change) =>
			change.insertText("everyone", support, support + "support".length),
		);

		editing.settle(first, "accept");

		expect(pendingSuggestions(editing.doc)).toMatchObject([
			{ id: second, removes: "support", adds: "everyone" },
		]);
	});
});
