import { applySuggestions, revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import {
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	suggestionsAsAttributes,
	suggestionsFromAttributes,
} from "@sugabots/contracts/live-document";
import {
	liveDocumentFromMarkdown as document,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { changedTo, withoutSuggestions } from "./suggestions.ts";

const asMarkdown = (node: Node) => markdownOfLiveDocument(node).trim();

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

/** The document once everything suggested in it is undone. */
function undone(node: Node): Node {
	const state = EditorState.create({ doc: node });
	let after = node;
	revertSuggestions(state, (transaction) => {
		after = transaction.doc;
	});
	return after;
}

/** The document as another editor receives it, through the shared type the sync layer carries. */
function synced(node: Node): Node {
	const shared = new Doc().getXmlFragment("default");
	prosemirrorToYXmlFragment(suggestionsAsAttributes(node), shared);
	return suggestionsFromAttributes(yXmlFragmentToProseMirrorRootNode(shared, liveDocumentSchema));
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

	const table = "| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |\n| Launch | Marco |";
	const images =
		"/api/pods/0199a3a0-0000-7000-8000-000000000001/artifacts/0199a3a0-0000-7000-8000-000000000002/images";
	const image = `![The launch chart](${images}/${"a".repeat(64)})`;
	const otherImage = `![The launch chart](${images}/${"b".repeat(64)})`;
	const linkedTo = (link: string) => `[${image}](${link})`;
	it.each([
		["adds a table", "# Plan\n\nShip.", `# Plan\n\nShip.\n\n${table}`],
		["changes a cell", `# Plan\n\n${table}`, `# Plan\n\n${table.replace("Priya", "Aiko")}`],
		["adds a row", `# Plan\n\n${table}`, `# Plan\n\n${table}\n| Retro | Aiko |`],
		["removes a table", `# Plan\n\n${table}\n\nEnd.`, "# Plan\n\nEnd."],
		["adds an image", "# Plan\n\nShip.", `# Plan\n\nShip.\n\n${image}`],
		["adds an image beside words", "# Plan\n\nShip it.", `# Plan\n\nShip ${image} it.`],
		["adds a mark", "Area is x2 today.", "Area is x<sup>2</sup> now."],
		["adds only a mark", "Ship on launch day now.", "Ship on <mark>launch day</mark> now."],
		["swaps an image", `Ship ${image} it.`, `Ship ${otherImage} it.`],
		["links an image", `Ship ${image} it.`, `Ship ${linkedTo("https://example.com/chart")} it.`],
		[
			"changes an image's link",
			`Ship ${linkedTo("https://example.com/chart")} it.`,
			`Ship ${linkedTo("https://example.com/plan")} it.`,
		],
		["unlinks an image", `Ship ${linkedTo("https://example.com/chart")} it.`, `Ship ${image} it.`],
		[
			"gives a cell a second line",
			"| A | B |\n| --- | --- |\n| x | 2 |",
			"| A | B |\n| --- | --- |\n| x<br>y | 2 |",
		],
	])("%s that reaches everyone, and is accepted or undone whole", (_, before, wanted) => {
		const live = document(before);

		const received = synced(suggested(live, wanted));

		expect(asMarkdown(withoutSuggestions(received))).toBe(asMarkdown(live));
		const [kept, dropped] = [accepted(received), undone(received)];
		kept.check();
		dropped.check();
		expect(asMarkdown(kept)).toBe(asMarkdown(document(wanted)));
		expect(asMarkdown(dropped)).toBe(asMarkdown(live));
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

	it("marks a word in the middle of a line, its text otherwise the same", () => {
		const wanted = "# Launch plan\n\nShip on **Friday** please.\n\n- Write the post";

		const edited = changedTo(
			document("# Launch plan\n\nShip on Friday please.\n\n- Write the post"),
			document(wanted),
			"edit",
		);

		expect(typeof edited === "string" ? edited : asMarkdown(edited)).toBe(
			asMarkdown(document(wanted)),
		);
	});
});
