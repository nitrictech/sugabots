import { enableSuggestChanges } from "@handlewithcare/prosemirror-suggest-changes";
import { liveDocumentExtensions } from "@sugabots/contracts/live-document";
import { Editor } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
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

	it("changes the document at once while the person is editing", () => {
		const { kim, sam } = twoPeople();

		kim.chain().setTextSelection({ from: 9, to: 15 }).insertContent("Monday").run();

		expect(lines(sam)).toBe("Ship on Monday. | Tell support.");
		expect(pendingSuggestions(sam.state.doc)).toEqual([]);
	});
});
