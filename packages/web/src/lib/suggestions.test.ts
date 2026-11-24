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
import { pendingSuggestions, settlingSuggestion } from "./suggestions.ts";

const schema = getSchema(liveDocumentExtensions({ kind: "document", undo: false }));

const paragraph = (words: string) => schema.node("paragraph", null, [schema.text(words)]);
const document = (...blocks: Node[]) => schema.node("doc", null, blocks);

/**
 * A document being edited in suggesting mode, whose every change becomes a
 * suggestion: by `by`, unless another person is named.
 */
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
		/** Makes the change `edit` describes, as one suggestion by `person`. */
		suggest(edit: (transaction: Transaction) => Transaction, person = by) {
			const id = `s${++made}:person:${person}`;
			state = state.apply(transformToSuggestionTransaction(edit(state.tr), state, () => id));
			return id;
		},
		settle(suggestionId: string, how: "accept" | "reject") {
			settlingSuggestion(suggestionId, how)(state, (transaction) => {
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

	it("says what a proposed table and image hold, in words", () => {
		const editing = plan();
		const cell = (type: string, words: string) => schema.node(type, null, [paragraph(words)]);
		const table = schema.node("table", null, [
			schema.node("tableRow", null, [
				cell("tableHeader", "Milestone"),
				cell("tableHeader", "Owner"),
			]),
			schema.node("tableRow", null, [cell("tableCell", "Beta"), cell("tableCell", "Priya")]),
		]);
		const image = schema.node("image", {
			src: "/api/pods/0199a3a0-0000-7000-8000-000000000001/artifacts/0199a3a0-0000-7000-8000-000000000002/images/0199a3a0-0000-7000-8000-000000000003",
			alt: "The launch chart",
		});

		const tableId = editing.suggest((change) => change.insert(change.doc.content.size, table));
		const imageId = editing.suggest((change) => change.insert(1, image));

		expect(pendingSuggestions(editing.doc)).toMatchObject([
			{ id: imageId, adds: "The launch chart" },
			{ id: tableId, adds: "Milestone Owner Beta Priya" },
		]);
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

describe("a block's kind, changed in a suggestion while somebody else's change of kind waits", () => {
	/** Each block's kind, with a heading's level. */
	const kinds = (doc: Node) =>
		doc.children.map((block) =>
			block.type.name === "heading" ? `heading ${block.attrs.level}` : block.type.name,
		);

	/** Makes the block at `position` a heading of `level`. */
	const asHeading = (position: number, level: number) => (change: Transaction) => {
		const heading = schema.node("heading", { level });
		return change.setNodeMarkup(position, heading.type, heading.attrs);
	};

	it.each([
		["accepted", "accept", "heading 2"],
		["rejected", "reject", "paragraph"],
	] as const)("is %s alone, the other left waiting as it was", (_, how, settled) => {
		const editing = suggesting(
			document(paragraph("Ship on Friday."), paragraph("Tell support.")),
			"Kim",
		);
		const second = editing.doc.child(0).nodeSize;
		const kims = editing.suggest(asHeading(0, 2));
		const sams = editing.suggest(asHeading(second, 3), "Sam");
		const samsBlock = editing.doc.child(1);

		editing.settle(kims, how);

		expect(kinds(editing.doc)).toEqual([settled, "heading 3"]);
		expect(pendingSuggestions(editing.doc)).toMatchObject([{ id: sams, by: { name: "Sam" } }]);
		expect(editing.doc.child(1).toJSON()).toEqual(samsBlock.toJSON());
	});
});
