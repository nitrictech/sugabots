import { applySuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import {
	liveDocumentExtensions,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
} from "@sugabots/contracts/live-document";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { changedTo, withoutSuggestions } from "./suggestions.ts";

const extensions = liveDocumentExtensions({ undo: true });
const schema = getSchema(extensions);
const markdown = new MarkdownManager({ extensions });

const document = (text: string) => Node.fromJSON(schema, markdown.parse(text));
const asMarkdown = (node: Node) => markdown.serialize(node.toJSON()).trim();

/** The document's lines, with text proposed for removal as `[-…-]` and proposed text as `[+…+]`. */
function shown(node: Node): string[] {
	const lines: string[] = [];
	node.descendants((child) => {
		if (!child.isTextblock) return;
		let line = "";
		child.forEach((inline) => {
			// The library marks where a block was split or joined with a character nobody sees.
			const text = (inline.text ?? "").replaceAll("​", "");
			if (inline.marks.some((mark) => mark.type.name === SUGGESTED_DELETION)) line += `[-${text}-]`;
			else if (inline.marks.some((mark) => mark.type.name === SUGGESTED_INSERTION)) {
				line += `[+${text}+]`;
			} else line += text;
		});
		lines.push(line.replaceAll("[++]", ""));
	});
	return lines;
}

/** The document as it reads once everything suggested in it is accepted. */
function accepted(node: Node): Node {
	const state = EditorState.create({ doc: node });
	let after = node;
	applySuggestions(state, (transaction) => {
		after = transaction.doc;
	});
	return after;
}

/** `live` after an agent suggests it read as `wanted`, which must be possible. */
function suggested(live: Node, wanted: string, suggestionId = "s1:agent:Planner"): Node {
	const after = changedTo(live, document(wanted), { suggestionId });
	if (typeof after === "string") throw new Error(`Expected a suggestion, got ${after}`);
	return after;
}

describe("an agent's suggestion in a live document", () => {
	const plan = document("# Launch plan\n\nShip on Friday. Tell support first.\n\n- Write the post");

	it("marks whole words, leaving the rest of the paragraph and every other block alone", () => {
		const after = suggested(
			plan,
			"# Launch plan\n\nShip on Monday. Tell support first.\n\n- Write the post",
		);

		expect(shown(after)).toEqual([
			"Launch plan",
			"Ship on [-Friday.-][+Monday.+] Tell support first.",
			"Write the post",
		]);
	});

	it("leaves the document reading as before until it is accepted, and as wanted once it is", () => {
		const wanted =
			"# Launch plan\n\nShip on Monday.\n\nBrief sales too.\n\n- Write the post\n- Record a demo";

		const after = suggested(plan, wanted);

		expect(asMarkdown(withoutSuggestions(after))).toBe(asMarkdown(plan));
		expect(asMarkdown(accepted(after))).toBe(asMarkdown(document(wanted)));
	});

	it("proposes removing a paragraph, which is gone once that is accepted", () => {
		const wanted = "# Launch plan\n\n- Write the post";

		const after = suggested(plan, wanted);

		expect(asMarkdown(withoutSuggestions(after))).toBe(asMarkdown(plan));
		expect(asMarkdown(accepted(after))).toBe(asMarkdown(document(wanted)));
	});

	it("keeps a suggestion pending elsewhere when a second is made", () => {
		const first = suggested(
			plan,
			"# Launch plan\n\nShip on Monday. Tell support first.\n\n- Write the post",
		);

		const second = suggested(
			first,
			"# Launch plan\n\nShip on Friday. Tell support first.\n\n- Write the announcement",
			"s2:agent:Planner",
		);

		expect(shown(second)).toEqual([
			"Launch plan",
			"Ship on [-Friday.-][+Monday.+] Tell support first.",
			"Write the [-post-][+announcement+]",
		]);
	});

	it("is blocked inside a code block, which can't be marked", () => {
		const code = document("```\nship()\n```");

		expect(
			changedTo(code, document("```\nship(now)\n```"), { suggestionId: "s1:agent:Planner" }),
		).toBe("unmarkable");
	});
});

describe("an agent's edit to a live document holding suggestions", () => {
	const plan = document("# Launch plan\n\nShip on Friday.\n\n- Write the post");

	it("changes its own paragraph and keeps a suggestion pending in another", () => {
		const pending = suggested(plan, "# Launch plan\n\nShip on Monday.\n\n- Write the post");

		const edited = changedTo(
			pending,
			document("# Launch plan for May\n\nShip on Friday.\n\n- Write the post"),
			"edit",
		);

		expect(typeof edited === "string" ? edited : shown(edited)).toEqual([
			"Launch plan for May",
			"Ship on [-Friday.-][+Monday.+]",
			"Write the post",
		]);
	});

	it("reads as wanted after an edit that adds, changes and removes blocks", () => {
		const wanted = "# Plan\n\nNew opening.\n\nShip on Friday.\n\n1. Write the post";

		const edited = changedTo(plan, document(wanted), "edit");

		expect(typeof edited === "string" ? edited : asMarkdown(edited)).toBe(
			asMarkdown(document(wanted)),
		);
	});

	it("is unchanged when the document already reads as wanted", () => {
		expect(changedTo(plan, document(asMarkdown(plan)), "edit")).toBe("unchanged");
	});
});
