import { enableSuggestChanges } from "@handlewithcare/prosemirror-suggest-changes";
import {
	liveDocumentExtensions,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
} from "@sugabots/contracts/live-document";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";
import { Suggesting, suggestingAs } from "./suggesting.ts";
import { pendingSuggestions, settlingSuggestion } from "./suggestions.ts";

const editors: Editor[] = [];
afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

/** Two people in one live document, each in their own editor, with what either does reaching the other. */
function twoPeople() {
	const [kims, sams] = [new Doc(), new Doc()];
	kims.on("update", (update, origin) => origin !== "sync" && applyUpdate(sams, update, "sync"));
	sams.on("update", (update, origin) => origin !== "sync" && applyUpdate(kims, update, "sync"));
	const editorOf = (document: Doc, name: string) => {
		const editor = new Editor({
			element: window.document.createElement("div"),
			extensions: [
				...liveDocumentExtensions({ kind: "document", undo: false }),
				Suggesting,
				Collaboration.configure({ document }),
			],
		});
		suggestingAs(editor, name);
		editors.push(editor);
		return editor;
	};
	const [kim, sam] = [editorOf(kims, "Kim"), editorOf(sams, "Sam")];
	kim.commands.setContent("<p>Ship on Friday.</p><p>Tell support.</p>");
	return { kim, sam };
}

const lines = (editor: Editor) => editor.getText({ blockSeparator: " | " });

/** The first paragraph, with words proposed for removal as `[-…-]` and proposed words as `[+…+]`. */
function markedFirstLine(editor: Editor): string {
	let line = "";
	editor.state.doc.child(0).forEach((inline) => {
		const text = inline.text ?? "";
		const names = inline.marks.map((mark) => mark.type.name);
		if (names.includes(SUGGESTED_DELETION)) line += `[-${text}-]`;
		else if (names.includes(SUGGESTED_INSERTION)) line += `[+${text}+]`;
		else line += text;
	});
	return line;
}

describe("suggesting mode, with somebody else in the document", () => {
	it("leaves what the person types for the other to accept", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);

		kim.chain().setTextSelection({ from: 9, to: 15 }).insertContent("Monday").run();

		expect(pendingSuggestions(sam.state.doc)).toMatchObject([
			{ by: { kind: "person", name: "Kim" }, removes: "Friday", adds: "Monday" },
		]);
		const [suggestion] = pendingSuggestions(sam.state.doc);
		settlingSuggestion(suggestion?.id ?? "", "accept")(sam.state, sam.view.dispatch);
		expect(lines(kim)).toBe("Ship on Monday. | Tell support.");
		expect(pendingSuggestions(kim.state.doc)).toEqual([]);
	});

	it("carries a suggestion to remove a whole paragraph, which the other accepts", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const second = kim.state.doc.child(0).nodeSize;

		kim.view.dispatch(kim.state.tr.delete(second, kim.state.doc.content.size));

		// Still there for both, and proposed for removal for both.
		expect(lines(sam)).toBe("Ship on Friday. | Tell support.");
		expect(pendingSuggestions(sam.state.doc)).toMatchObject([{ removes: "Tell support." }]);
		const [suggestion] = pendingSuggestions(sam.state.doc);
		settlingSuggestion(suggestion?.id ?? "", "accept")(sam.state, sam.view.dispatch);
		expect(lines(sam)).toBe("Ship on Friday.");
		expect(lines(kim)).toBe("Ship on Friday.");
		expect(pendingSuggestions(kim.state.doc)).toEqual([]);
	});

	it("carries a suggestion to add a whole paragraph, which the other rejects", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);

		kim.view.dispatch(
			kim.state.tr.insert(
				kim.state.doc.content.size,
				kim.schema.node("paragraph", null, [kim.schema.text("Brief sales too.")]),
			),
		);

		expect(pendingSuggestions(sam.state.doc)).toMatchObject([{ adds: "Brief sales too." }]);
		const [suggestion] = pendingSuggestions(sam.state.doc);
		settlingSuggestion(suggestion?.id ?? "", "reject")(sam.state, sam.view.dispatch);
		expect(lines(sam)).toBe("Ship on Friday. | Tell support.");
		expect(lines(kim)).toBe("Ship on Friday. | Tell support.");
	});

	it("takes back the person's suggestion to remove a whole paragraph with one undo, and nothing before it", () => {
		const { kim, sam } = twoPeople();
		const undoing = yUndoPluginKey.getState(kim.state)?.undoManager;
		undoing?.stopCapturing();
		kim.commands.insertContentAt("Ship on Friday".length + 1, " at noon");
		undoing?.stopCapturing();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const second = kim.state.doc.child(0).nodeSize;
		kim.view.dispatch(kim.state.tr.delete(second, kim.state.doc.content.size));
		undoing?.stopCapturing();
		expect(pendingSuggestions(sam.state.doc)).toHaveLength(1);

		kim.commands.undo();

		expect(pendingSuggestions(sam.state.doc)).toEqual([]);
		expect(lines(sam)).toBe("Ship on Friday at noon. | Tell support.");
	});

	it("keeps what the person types on from their own suggestion in that suggestion", () => {
		const { kim, sam } = twoPeople();
		enableSuggestChanges(kim.state, kim.view.dispatch);
		const end = "Ship on Friday".length + 1;

		kim.commands.insertContentAt(end, " or");
		kim.commands.insertContentAt(end + " or".length, " Monday");

		expect(pendingSuggestions(sam.state.doc)).toMatchObject([{ adds: " or Monday" }]);
	});

	it.each([
		["Kim", "just before", "Ship on ".length],
		["Kim", "inside", "Ship on Fri".length],
		["Kim", "just after", "Ship on Friday".length],
		["Sam", "just before", "Ship on ".length],
		["Sam", "inside", "Ship on Fri".length],
		["Sam", "just after", "Ship on Friday".length],
	] as const)(
		"puts what the person types after words %s proposes removing when typed %s them, leaving the removal whole",
		(remover, _, offset) => {
			const { kim, sam } = twoPeople();
			for (const editor of [kim, sam]) enableSuggestChanges(editor.state, editor.view.dispatch);
			const removing = remover === "Kim" ? kim : sam;
			const friday = { from: "Ship on ".length + 1, to: "Ship on Friday".length + 1 };
			removing.view.dispatch(removing.state.tr.delete(friday.from, friday.to));

			kim.view.dispatch(kim.state.tr.insertText("Monday", offset + 1));

			expect(markedFirstLine(sam)).toBe("Ship on [-Friday-][+Monday+].");
		},
	);

	it("changes the document at once while the person is editing", () => {
		const { kim, sam } = twoPeople();

		kim.chain().setTextSelection({ from: 9, to: 15 }).insertContent("Monday").run();

		expect(lines(sam)).toBe("Ship on Monday. | Tell support.");
		expect(pendingSuggestions(sam.state.doc)).toEqual([]);
	});
});
