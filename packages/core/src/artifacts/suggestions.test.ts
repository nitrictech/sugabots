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
import {
	type ChangeAs,
	changedTo,
	textWithoutSuggestions,
	withoutSuggestions,
} from "./suggestions.ts";

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
	if (!("document" in after)) throw new Error(`Expected a change, got ${JSON.stringify(after)}`);
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

		expect(changedTo(code, "```\nship(now)\n```", { suggestionId: "s1:agent:Planner" })).toEqual({
			outcome: "refused",
			reason: "unmarkable",
		});
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
		expect(changedTo(plan, asMarkdown(plan), "edit")).toEqual({ outcome: "unchanged" });
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
		expect(document(textWithoutSuggestions(plan)).eq(plan)).toBe(false);

		expect(changedTo(plan, textWithoutSuggestions(plan), as)).toEqual({ outcome: "unchanged" });
	});

	it.each(MADE_OR_SUGGESTED)("changes only the paragraph the agent changes, %s", (_, as) => {
		const after = changed(plan, textWithoutSuggestions(plan).replace("Friday", "Monday"), as);

		expect(after.childCount).toBe(plan.childCount);
		expect(changedChildren(plan, after)).toEqual([4]);
		expect(asMarkdown(accepted(after))).toContain("Ship on Monday.");
	});
});

describe("an agent's change to a live document, suggested again", () => {
	const plan = document("Ship on Friday. Tell support first.");
	const onMonday = "Ship on Monday. Tell support first.";

	it("replaces its own suggestion waiting there rather than add the same words beside it", () => {
		const first = suggested(plan, onMonday, "s1:agent:Planner");

		const again = suggested(first, onMonday, "s2:agent:Planner");

		expect(shown(again)).toEqual(["Ship on [-Friday.-][+Monday.+] Tell support first."]);
		expect(asMarkdown(accepted(again))).toBe(onMonday);
		expect(asMarkdown(undone(again))).toBe(asMarkdown(plan));
	});

	it("replaces its own suggestion waiting there with a second wording", () => {
		const first = suggested(plan, onMonday, "s1:agent:Planner");

		const again = suggested(first, "Ship on Tuesday. Tell support first.", "s2:agent:Planner");

		expect(shown(again)).toEqual(["Ship on [-Friday.-][+Tuesday.+] Tell support first."]);
	});

	it("leaves a person's suggestion waiting there as theirs", () => {
		const kims = suggested(plan, onMonday, "s1:person:Kim");

		const again = suggested(kims, "Ship on Tuesday. Tell support first.", "s2:agent:Planner");

		expect(shown(again)[0]).toContain("Monday.");
		expect(shown(again)[0]).toContain("Tuesday.");
	});
});

/*
 * Decks as a bot writes them, by hand: frames where it put them, some boxes
 * left where the layout puts them, list items without paragraphs.
 */

const GOALS = `<section data-slide data-layout="bullets">
  <div data-slide-body>
    <div data-slide-box data-role="title" style="left:80px;top:64px;width:800px;height:48px"><h2>Goals</h2></div>
    <div data-slide-box data-role="body" style="left:80px;top:144px;width:560px;height:332px"><ul><li>Ship on Friday</li><li>Tell support first</li></ul></div>
    <div data-slide-box style="left:680px;top:144px;width:200px;height:96px;background:#0f766e"><p>On track</p></div>
  </div>
  <aside data-speaker-notes><p>Start with the date.</p></aside>
</section>`;

const RISKS = `<section data-slide data-layout="bullets">
  <div data-slide-body>
    <div data-slide-box data-role="title" style="left:80px;top:64px;width:800px;height:48px"><h2>Risks</h2></div>
    <div data-slide-box data-role="body" style="left:80px;top:144px;width:800px;height:332px"><ul><li>None yet</li></ul></div>
  </div>
</section>`;

const deck = (html: string) => deckFromHtml(html, readHtml);

const SUGGESTION: ChangeAs = { suggestionId: "s1:agent:Planner" };

/** The outcome of an agent's change, with the document it gives, which there must be. */
function changeOf(live: Node, wanted: string, as: ChangeAs): { outcome: string; document: Node } {
	const after = changedTo(live, wanted, as);
	if (!("document" in after)) throw new Error(`Expected a change, got ${JSON.stringify(after)}`);
	return after;
}

/** The ids of the suggestions waiting in `node`, on its nodes and its text. */
function suggestionIdsIn(node: Node): Set<string> {
	const ids = new Set<string>();
	node.descendants((child) => {
		for (const mark of child.marks) {
			if (["insertion", "deletion", "modification"].includes(mark.type.name)) {
				ids.add(String(mark.attrs.id));
			}
		}
	});
	return ids;
}

/** The names of the suggestion marks on each box of slide `index`. */
const boxMarks = (node: Node, index: number) =>
	bodyOf(node.child(index)).children.map((box) => box.marks.map((mark) => mark.type.name));

/** Settling `after` gives the deck `wanted` reads as once accepted, and the deck `live` was once rejected, compared as documents. */
function expectSettled(after: Node, wanted: string, live: Node) {
	expect(accepted(after).toJSON()).toEqual(deck(wanted).toJSON());
	expect(undone(after).toJSON()).toEqual(live.toJSON());
}

describe("an agent's suggestion in a live deck", () => {
	const live = deck(GOALS + RISKS);

	it("rewords a box as a suggestion, leaving every box where it is", () => {
		const after = suggested(live, (GOALS + RISKS).replace("Ship on Friday", "Ship on Monday"));

		expect(shown(after)).toContain("Ship on [-Friday-][+Monday+]");
		expect(bodyOf(after.child(0)).children.map(boxAttributesOf)).toEqual(
			bodyOf(live.child(0)).children.map(boxAttributesOf),
		);
	});

	it("lays a slide out in columns as one suggestion, which rejected leaves the slide as it was", () => {
		const inColumns = GOALS.replace('data-layout="bullets"', 'data-layout="columns"')
			.replace(
				'data-role="body" style="left:80px;top:144px;width:560px;height:332px"',
				'data-role="leftColumn"',
			)
			.replace(
				"</ul></div>\n",
				'</ul></div>\n    <div data-slide-box data-role="rightColumn"><ul><li>Brief sales</li></ul></div>\n',
			);

		const after = changeOf(live, inColumns + RISKS, SUGGESTION);

		expect(after.outcome).toBe("suggested");
		expect(suggestionIdsIn(after.document)).toEqual(new Set(["s1:agent:Planner"]));
		expectSettled(after.document, inColumns + RISKS, live);
	});

	it("recolours a line while rewording a word in it as one suggestion, which rejected leaves the line as it was", () => {
		const wanted = GOALS.replace(
			"<li>Ship on Friday</li>",
			'<li><span style="color: #b91c1c">Ship on Monday</span></li>',
		);

		const after = changeOf(live, wanted + RISKS, SUGGESTION);

		expect(after.outcome).toBe("suggested");
		expectSettled(after.document, wanted + RISKS, live);
	});

	it("suggests moving and refilling a box and colouring its slide, with no word changed", () => {
		const wanted = GOALS.replace(
			'data-layout="bullets">',
			'data-layout="bullets" style="background: #0f172a">',
		).replace(
			"left:680px;top:144px;width:200px;height:96px;background:#0f766e",
			"left:680px;top:380px;width:200px;height:96px;background:#b91c1c",
		);

		const after = changeOf(live, wanted + RISKS, SUGGESTION);

		expect(after.outcome).toBe("suggested");
		// The new design shows at once, each attribute's mark keeping what it was.
		const slide = after.document.child(0);
		expect(slide.attrs.background).toBe("#0f172a");
		expect(slide.marks.map((mark) => mark.attrs)).toEqual([
			{
				id: "s1:agent:Planner",
				type: "attr",
				attrName: "background",
				previousValue: null,
				newValue: "#0f172a",
			},
		]);
		const badge = bodyOf(slide).child(2);
		expect(badge.marks.map((mark) => mark.attrs.attrName).toSorted()).toEqual(["fill", "frame"]);
		expectSettled(after.document, wanted + RISKS, live);
	});

	it("removes an empty subtitle and adds a shape as two boxes, not one turned into the other", () => {
		const titled = (box: string) =>
			`<section data-slide data-layout="title"><div data-slide-body><div data-slide-box data-role="title"><h1>Launch review</h1></div>${box}</div></section>`;
		const subtitle = titled('<div data-slide-box data-role="subtitle"><p></p></div>');
		const shape = titled(
			'<div data-slide-box style="left:40px;top:40px;width:100px;height:100px"><svg viewBox="0 0 100 100"><path d="M 0 0 L 100 0 L 100 100 Z" fill="#ff0000"/></svg></div>',
		);
		const titleSlide = deck(subtitle);

		const after = changeOf(titleSlide, shape, SUGGESTION);

		expect(boxMarks(after.document, 0)).toEqual([[], ["deletion"], ["insertion"]]);
		expectSettled(after.document, shape, titleSlide);
	});

	it("adds a box it suggested already once, however often it is asked", () => {
		const noted = GOALS.replace(
			"<p>On track</p></div>\n",
			'<p>On track</p></div>\n    <div data-slide-box style="left:80px;top:420px;width:300px;height:40px"><p>Owner: Kim</p></div>\n',
		);
		const first = suggested(live, noted + RISKS, "s1:agent:Planner");

		const again = suggested(first, noted + RISKS, "s2:agent:Planner");

		expect(bodyOf(accepted(again).child(0)).childCount).toBe(4);
		expect(undone(again).toJSON()).toEqual(live.toJSON());
	});

	it("takes a slide by its title box, not by a bar drawn above it, removing one slide and rewording the next", () => {
		const barred = (title: string, point: string) =>
			`<section data-slide data-layout="bullets"><div data-slide-body><div data-slide-box style="left:0px;top:0px;width:960px;height:16px;background:#0f766e"><p></p></div><div data-slide-box data-role="title"><h2>${title}</h2></div><div data-slide-box data-role="body"><ul><li>${point}</li></ul></div></div></section>`;
		const three = deck(
			barred("Goals", "Ship on Friday") + barred("Risks", "None yet") + barred("Next", "Retro"),
		);
		const wanted = barred("Risks", "Supplier delay") + barred("Next", "Retro");

		const after = changeOf(three, wanted, SUGGESTION).document;

		expect(after.children.map((slide) => slide.marks.map((mark) => mark.type.name))).toEqual([
			["deletion"],
			[],
			[],
		]);
		expect(shown(after)).toContain("[-None yet-][+Supplier delay+]");
		expectSettled(after, wanted, three);
	});

	it("moves a box behind another at once, keeping a person's suggestion waiting in each", () => {
		const kims = changeOf(live, (GOALS + RISKS).replace("Ship on Friday", "Ship on Monday"), {
			suggestionId: "s0:person:Kim",
		}).document;
		const [title = "", body = "", badge = ""] =
			/(\s*<div data-slide-box data-role="title".*?<\/div>)(\s*<div data-slide-box data-role="body".*?<\/ul><\/div>)(\s*<div data-slide-box style="left:680px.*?<\/div>)/s
				.exec(GOALS)
				?.slice(1) ?? [];
		const badgeInFront = GOALS.replace(title + body + badge, title + badge + body);

		const after = changeOf(kims, badgeInFront + RISKS, SUGGESTION);

		expect(after.outcome).toBe("made");
		expect(bodyOf(after.document.child(0)).children.map((box) => box.textContent)).toEqual([
			"Goals",
			"On track",
			"Ship on FridayMondayTell support first",
		]);
		expect(boxMarks(after.document, 0)).toEqual([[], [], []]);
		expect(shown(after.document)).toContain("Ship on [-Friday-][+Monday+]");
	});

	it("keeps a person's suggestion waiting in a box it moves and rewords", () => {
		const box = (left: number, words: string) =>
			`<section data-slide><div data-slide-body><div data-slide-box style="left:${left}px;top:10px;width:200px;height:50px"><p>${words}</p></div></div></section>`;
		const kims = changeOf(deck(box(10, "On track")), box(10, "On schedule"), {
			suggestionId: "s0:person:Kim",
		}).document;

		const after = changeOf(kims, box(300, "Ahead"), "edit").document;

		expect(boxAttributesOf(bodyOf(after.child(0)).child(0)).frame.x).toBe(300);
		expect(shown(after)[0]).toContain("[+schedule+]");
	});
});

describe("an agent's edit to a live deck", () => {
	const live = deck(GOALS + RISKS);

	it.each([
		["made", "edit"],
		["suggested", SUGGESTION],
	] as const)("moves and refills a box, its outcome %s", (outcome, as) => {
		const wanted = GOALS.replace(
			"left:680px;top:144px;width:200px;height:96px;background:#0f766e",
			"left:680px;top:380px;width:200px;height:96px;background:#b91c1c",
		);

		const after = changeOf(live, wanted + RISKS, as);

		expect(after.outcome).toBe(outcome);
		expect(holdsSuggestion(after.document)).toBe(outcome === "suggested");
		expect(boxAttributesOf(bodyOf(after.document.child(0)).child(2))).toMatchObject({
			frame: { x: 680, y: 380, width: 200, height: 96 },
			fill: "#b91c1c",
		});
	});

	it("recolours a line with what a person proposes adding at its end, so it reads in one colour however that is settled", () => {
		const kims = changeOf(live, (GOALS + RISKS).replace("Ship on Friday", "Ship on Monday"), {
			suggestionId: "s0:person:Kim",
		}).document;
		const recoloured = GOALS.replace(
			"<li>Ship on Friday</li>",
			'<li><span style="color: #b91c1c">Ship on Friday</span></li>',
		);

		const after = changeOf(kims, recoloured + RISKS, "edit").document;

		const colours: unknown[] = [];
		after.child(0).descendants((node) => {
			if (node.isText && /Ship|Friday|Monday/.test(node.text ?? "")) {
				colours.push(node.marks.find((mark) => mark.type.name === "textStyle")?.attrs.color);
			}
		});
		expect(colours.length).toBeGreaterThan(1);
		expect(new Set(colours)).toEqual(new Set(["#b91c1c"]));
		expect(shown(after)).toContain("Ship on [-Friday-][+Monday+]");
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
		for (const [, as] of MADE_OR_SUGGESTED)
			expect(changedTo(live, wanted, as)).toEqual({ outcome: "refused", reason: why });
	});

	it("reads the deck written inside a whole page as the deck, which is unchanged", () => {
		const page = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch review</title><style>section { margin: 0 }</style></head>
<body>
${BOT_DECK}
</body>
</html>`;

		for (const [, as] of MADE_OR_SUGGESTED)
			expect(changedTo(live, page, as)).toEqual({ outcome: "unchanged" });
	});
});
