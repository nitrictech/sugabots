import { applySuggestions, revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import { deckFromHtml } from "@sugabots/contracts/deck-html";
import {
	holdsSuggestion,
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	suggestionsAsAttributes,
	suggestionsFromAttributes,
} from "@sugabots/contracts/live-document";
import {
	documentFromMarkdown,
	liveDocumentSchema,
	markdownOfDocument,
} from "@sugabots/contracts/live-document-text";
import { bodyOf, boxAttributesOf } from "@sugabots/contracts/live-slides";
import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { readHtml } from "./html-reader.ts";
import { type ChangeAs, changedTo, textForAgents, withoutSuggestions } from "./suggestions.ts";

const document = (text: string) => documentFromMarkdown(text);

const asMarkdown = (node: Node) => markdownOfDocument(node).trim();

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
	return suggestionsFromAttributes(yXmlFragmentToProseMirrorRootNode(shared, node.type.schema));
}

/** `live` after an agent suggests it read as the text `wanted`, which must be possible. */
function suggested(live: Node, wanted: string, suggestionId = "s1:agent:Planner"): Node {
	return changed(live, wanted, { suggestionId });
}

/** `live` after an agent asks for it to read as the text `wanted`, which must be possible. */
function changed(live: Node, wanted: string, as: ChangeAs): Node {
	const after = changedTo(live, wanted, as);
	if (typeof after === "string") throw new Error(`Expected a change, got ${after}`);
	return after.document;
}

/** How an agent's change is made, by what each way is called. */
const MADE_OR_SUGGESTED: [string, ChangeAs][] = [
	["made", "edit"],
	["suggested", { suggestionId: "s1:agent:Planner" }],
];

/** The children of `after`, by index, that aren't the same as `before`'s in their place. */
const changedChildren = (before: Node, after: Node) =>
	after.children.flatMap((child, index) => {
		const was = before.maybeChild(index);
		return was && child.eq(was) ? [] : [index];
	});

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

	it("puts a paragraph it adds in front of one proposed for removal where its markdown says", () => {
		const removing = suggested(plan, "# Launch plan\n\n- Write the post");

		const after = suggested(
			removing,
			"# Launch plan\n\nBrief sales.\n\nShip on Friday. Tell support first.\n\n- Write the post",
			"s2:agent:Planner",
		);

		expect(after.children.map((block) => block.textContent)).toEqual([
			"Launch plan",
			"Brief sales.",
			"Ship on Friday. Tell support first.",
			"Write the post",
		]);
		expect(asMarkdown(accepted(after))).toBe(
			asMarkdown(document("# Launch plan\n\nBrief sales.\n\n- Write the post")),
		);
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

		expect(changedTo(code, "```\nship(now)\n```", { suggestionId: "s1:agent:Planner" })).toBe(
			"unmarkable",
		);
	});
});

describe("an agent's edit to a live document holding suggestions", () => {
	const plan = document("# Launch plan\n\nShip on Friday.\n\n- Write the post");

	it("changes its own paragraph and keeps a suggestion pending in another", () => {
		const pending = suggested(plan, "# Launch plan\n\nShip on Monday.\n\n- Write the post");

		const edited = changed(
			pending,
			"# Launch plan for May\n\nShip on Friday.\n\n- Write the post",
			"edit",
		);

		expect(shown(edited)).toEqual([
			"Launch plan for May",
			"Ship on [-Friday.-][+Monday.+]",
			"Write the post",
		]);
	});

	it("reads as wanted after an edit that adds, changes and removes blocks", () => {
		const wanted = "# Plan\n\nNew opening.\n\nShip on Friday.\n\n1. Write the post";

		const edited = changed(plan, wanted, "edit");

		expect(asMarkdown(edited)).toBe(asMarkdown(document(wanted)));
	});

	it("is unchanged when the document already reads as wanted", () => {
		expect(changedTo(plan, asMarkdown(plan), "edit")).toBe("unchanged");
	});

	it("marks a word in the middle of a line, its text otherwise the same", () => {
		const wanted = "# Launch plan\n\nShip on **Friday** please.\n\n- Write the post";

		const edited = changed(
			document("# Launch plan\n\nShip on Friday please.\n\n- Write the post"),
			wanted,
			"edit",
		);

		expect(asMarkdown(edited)).toBe(asMarkdown(document(wanted)));
	});
});

describe("an agent's change to a live document holding what its markdown can't say", () => {
	const schema = liveDocumentSchema("document");
	const node = (type: string, content?: Node | Node[]) => schema.node(type, null, content);
	const paragraph = (text: string) => node("paragraph", schema.text(text));
	const list = (item: string) => node("bulletList", node("listItem", paragraph(item)));
	/** Words that markdown reads as a heading, and two lists side by side, which it reads as one. */
	const plan = node("doc", [
		paragraph("Launch plan"),
		paragraph("# is how a heading starts"),
		list("Write the post"),
		list("Record a demo"),
		paragraph("Ship on Friday."),
	]);

	it.each(MADE_OR_SUGGESTED)("is unchanged when the agent changes nothing, %s", (_, as) => {
		// The markdown the agent reads doesn't read back as the document.
		expect(document(textForAgents(plan)).eq(plan)).toBe(false);

		expect(changedTo(plan, textForAgents(plan), as)).toBe("unchanged");
	});

	it.each(MADE_OR_SUGGESTED)("changes only the paragraph the agent changes, %s", (_, as) => {
		const after = changed(plan, textForAgents(plan).replace("Friday", "Monday"), as);

		expect(after.childCount).toBe(plan.childCount);
		expect(changedChildren(plan, after)).toEqual([4]);
		expect(asMarkdown(accepted(after))).toContain("Ship on Monday.");
	});
});

describe("an agent's change to a live deck", () => {
	/** A slide of a title, a list beside a badge, and notes. */
	const live = deckFromHtml(
		`<section data-slide data-layout="bullets">
			<div data-slide-body>
				<div data-slide-box data-role="title" style="left: 80px; top: 64px; width: 800px; height: 48px"><h2>Goals</h2></div>
				<div data-slide-box data-role="body" style="left: 80px; top: 144px; width: 560px; height: 332px"><ul><li><p>Ship on Friday</p></li></ul></div>
				<div data-slide-box style="left: 680px; top: 144px; width: 200px; height: 96px; background: #0f766e"><p>On track</p></div>
			</div>
			<aside data-speaker-notes><p>Start with the date.</p></aside>
		</section>`,
		readHtml,
	);
	const suggestion = { suggestionId: "s1:agent:Planner" };
	/** How each box on the deck's one slide is drawn. */
	const boxesOf = (deck: Node) => bodyOf(deck.child(0)).children.map(boxAttributesOf);

	it("suggests a word it rewrites in a box, leaving every box where it is", () => {
		const after = suggested(live, textForAgents(live).replace("Ship on Friday", "Ship on Monday"));

		expect(shown(after)).toContain("Ship on [-Friday-][+Monday+]");
		expect(boxesOf(after)).toEqual(boxesOf(live));
		expect(shown(accepted(after))).toContain("Ship on Monday");
	});

	it.each(MADE_OR_SUGGESTED)(
		"moves and refills a box at once, suggesting nothing, when the change is %s",
		(_, as) => {
			const wanted = textForAgents(live)
				.replace("left: 680px; top: 144px", "left: 680px; top: 380px")
				.replace("background: #0f766e", "background: #b91c1c");

			const after = changedTo(live, wanted, as);

			if (typeof after === "string") throw new Error(`Expected a change, got ${after}`);
			expect(after.suggested).toBe(false);
			expect(holdsSuggestion(after.document)).toBe(false);
			expect(boxesOf(after.document)[2]).toMatchObject({
				frame: { x: 680, y: 380, width: 200, height: 96 },
				fill: "#b91c1c",
			});
			expect(textForAgents(after.document)).toBe(wanted);
		},
	);

	it("moves a box at once and suggests the words it rewrites in the same change", () => {
		const wanted = textForAgents(live)
			.replace("left: 680px; top: 144px", "left: 680px; top: 380px")
			.replace("Ship on Friday", "Ship on Monday");

		const after = changedTo(live, wanted, suggestion);

		if (typeof after === "string") throw new Error(`Expected a change, got ${after}`);
		expect(after.suggested).toBe(true);
		expect(boxesOf(after.document)[2]?.frame.y).toBe(380);
		expect(shown(after.document)).toContain("Ship on [-Friday-][+Monday+]");
		expect(boxesOf(undone(after.document))[2]?.frame.y).toBe(380);
	});
});

describe("an agent's rewrite of a live deck in HTML that can't be the deck", () => {
	/** A deck as a bot writes one by hand: frames where it put them, some left to the layout, and list items without paragraphs. */
	const BOT_DECK = `<section data-slide data-layout="bullets">
  <div data-slide-body>
    <div data-slide-box data-role="title" style="left:80px;top:64px;width:800px;height:48px"><h2>Goals</h2></div>
    <div data-slide-box data-role="body" style="left:80px; top:144px; width:560px; height:332px">
      <ul><li>Ship on Friday</li><li>Tell support first</li></ul>
    </div>
  </div>
  <aside data-speaker-notes><p>Start with the date.</p></aside>
</section>
<section data-slide data-layout="section">
  <div data-slide-body><div data-slide-box data-role="title"><h2>Questions</h2></div></div>
</section>`;
	const live = deckFromHtml(BOT_DECK, readHtml);

	it.each([
		["empty", "", "saysNothing"],
		["only a comment", "<!-- The slides go here. -->", "saysNothing"],
		[
			"elements nested 20,000 deep",
			`${"<div>".repeat(20_000)}Goals${"</div>".repeat(20_000)}`,
			"nestedTooDeeply",
		],
	])("is refused, saying why, when it is %s, rather than empty the deck", (_, wanted, why) => {
		for (const [, as] of MADE_OR_SUGGESTED) expect(changedTo(live, wanted, as)).toBe(why);
	});

	it("reads the deck written inside a whole page as the deck, which is unchanged", () => {
		const page = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch review</title><style>section { margin: 0 }</style></head>
<body>
${BOT_DECK}
</body>
</html>`;

		for (const [, as] of MADE_OR_SUGGESTED) expect(changedTo(live, page, as)).toBe("unchanged");
	});
});
