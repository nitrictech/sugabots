import { applySuggestions, revertSuggestions } from "@handlewithcare/prosemirror-suggest-changes";
import {
	SUGGESTED_DELETION,
	SUGGESTED_INSERTION,
	suggestionsAsAttributes,
	suggestionsFromAttributes,
} from "@sugabots/contracts/live-document";
import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import {
	bodyOf,
	fitSlideBody,
	isMarkedRemoved,
	isOffItsSlide,
	layoutOf,
	newSlide,
	placementOf,
} from "@sugabots/contracts/live-slides";
import { SLIDE_LAYOUTS } from "@sugabots/contracts/slides-markdown";
import type { Node } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { titleOf, withBoxRemoved, withSlidePlaced } from "./slides.test-support.ts";
import { type ChangeAs, changedTo, markdownForAgents, withoutSuggestions } from "./suggestions.ts";

const document = (text: string) => liveDocumentFromMarkdown("document", text);

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
	return suggestionsFromAttributes(yXmlFragmentToProseMirrorRootNode(shared, node.type.schema));
}

/** `live` after an agent suggests it read as the markdown `wanted`, which must be possible. */
function suggested(live: Node, wanted: string, suggestionId = "s1:agent:Planner"): Node {
	return changed(live, wanted, { suggestionId });
}

/** `live` after an agent asks for it to read as the markdown `wanted`, which must be possible. */
function changed(live: Node, wanted: string, as: ChangeAs): Node {
	const after = changedTo(live, wanted, as);
	if (typeof after === "string") throw new Error(`Expected a change, got ${after}`);
	return after;
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

		const edited = changedTo(
			pending,
			"# Launch plan for May\n\nShip on Friday.\n\n- Write the post",
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

		const edited = changedTo(plan, wanted, "edit");

		expect(typeof edited === "string" ? edited : asMarkdown(edited)).toBe(
			asMarkdown(document(wanted)),
		);
	});

	it("is unchanged when the document already reads as wanted", () => {
		expect(changedTo(plan, asMarkdown(plan), "edit")).toBe("unchanged");
	});

	it("marks a word in the middle of a line, its text otherwise the same", () => {
		const wanted = "# Launch plan\n\nShip on **Friday** please.\n\n- Write the post";

		const edited = changedTo(
			document("# Launch plan\n\nShip on Friday please.\n\n- Write the post"),
			wanted,
			"edit",
		);

		expect(typeof edited === "string" ? edited : asMarkdown(edited)).toBe(
			asMarkdown(document(wanted)),
		);
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
		expect(document(markdownForAgents(plan)).eq(plan)).toBe(false);

		expect(changedTo(plan, markdownForAgents(plan), as)).toBe("unchanged");
	});

	it.each(MADE_OR_SUGGESTED)("changes only the paragraph the agent changes, %s", (_, as) => {
		const after = changed(plan, markdownForAgents(plan).replace("Friday", "Monday"), as);

		expect(after.childCount).toBe(plan.childCount);
		expect(changedChildren(plan, after)).toEqual([4]);
		expect(asMarkdown(accepted(after))).toContain("Ship on Monday.");
	});
});

const deck = (text: string) => liveDocumentFromMarkdown("slides", text);

const slides = (...texts: string[]) => texts.join("\n\n---\n\n");

/** The slides, by number from 1, whose body doesn't hold what their layout says. */
const unfitted = (node: Node) =>
	node.children.flatMap((slide, index) => {
		const body = slide.child(0);
		return fitSlideBody(body, layoutOf(slide)).eq(body) ? [] : [index + 1];
	});

/** The suggestion marks on each slide itself, by name. */
const slideMarks = (node: Node) =>
	node.children.map((slide) => slide.marks.map((mark) => mark.type.name));

const TITLE = "<!-- layout: title -->\n\n# Launch review";
const GOALS =
	"<!-- layout: bullets -->\n\n## Goals\n\n- Ship on Friday\n- Tell support first\n\n<!-- notes: Start with the date. -->";
const COLUMNS =
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- box -->\n\n- People type\n\n<!-- box -->\n\n- Bots suggest";
const QUESTIONS = "<!-- layout: section -->\n\n## Questions";

describe("an agent's suggestion in a deck", () => {
	const live = deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS));

	it("puts a slide it adds in front of one proposed for removal where its markdown says", () => {
		const removing = suggested(live, slides(TITLE, COLUMNS, QUESTIONS));

		const after = suggested(
			removing,
			slides(TITLE, "<!-- layout: section -->\n\n## Budget", GOALS, COLUMNS, QUESTIONS),
			"s2:agent:Planner",
		);

		expect(after.children.map(titleOf)).toEqual([
			"Launch review",
			"Budget",
			"Goals",
			"People and bots",
			"Questions",
		]);
		expect(slideMarks(after).slice(1, 3)).toEqual([["insertion"], ["deletion"]]);
	});

	it.each([
		[
			"changes words on a slide",
			slides(TITLE, GOALS.replace("Friday", "Monday"), COLUMNS, QUESTIONS),
		],
		[
			"adds a slide",
			slides(
				TITLE,
				GOALS,
				"<!-- layout: bullets -->\n\n## Risks\n\n- None yet",
				COLUMNS,
				QUESTIONS,
			),
		],
		["removes a slide", slides(TITLE, COLUMNS, QUESTIONS)],
		["removes the last slide", slides(TITLE, GOALS, COLUMNS)],
		[
			"lays a slide out in columns",
			slides(TITLE, GOALS.replace("layout: bullets", "layout: columns"), COLUMNS, QUESTIONS),
		],
		[
			"lays a slide in columns out in one flow",
			slides(TITLE, GOALS, COLUMNS.replace("layout: columns", "layout: bullets"), QUESTIONS),
		],
		[
			"changes a slide's layout alone",
			slides(TITLE, GOALS, COLUMNS, QUESTIONS.replace("layout: section", "layout: bullets")),
		],
		[
			"changes a slide's notes",
			slides(
				TITLE,
				GOALS.replace("Start with the date.", "Start with the new date."),
				COLUMNS,
				QUESTIONS,
			),
		],
		[
			"gives a slide notes",
			slides(TITLE, GOALS, COLUMNS, `${QUESTIONS}\n\n<!-- notes: Leave ten minutes. -->`),
		],
		[
			"adds a slide and changes words on the one after it",
			slides(
				TITLE,
				"<!-- layout: section -->\n\n## Plan",
				GOALS.replace("Friday", "Monday"),
				COLUMNS,
				QUESTIONS,
			),
		],
	])("%s, as a suggestion that reaches everyone and is accepted or undone whole", (_, wanted) => {
		const received = synced(suggested(live, wanted));

		received.check();
		expect(asMarkdown(withoutSuggestions(received))).toBe(asMarkdown(live));
		const [kept, dropped] = [accepted(received), undone(received)];
		kept.check();
		dropped.check();
		expect(unfitted(kept)).toEqual([]);
		expect(unfitted(dropped)).toEqual([]);
		expect(asMarkdown(kept)).toBe(asMarkdown(deck(wanted)));
		expect(asMarkdown(dropped)).toBe(asMarkdown(live));
	});

	it("marks the words that change on a slide, and no other slide", () => {
		const after = suggested(
			live,
			slides(TITLE, GOALS.replace("Friday", "Monday"), COLUMNS, QUESTIONS),
		);

		// The title slide's empty subtitle and the section break's empty label hold lines too.
		expect(shown(after)).toEqual([
			"Launch review",
			"",
			"",
			"Goals",
			"Ship on [-Friday-][+Monday+]",
			"Tell support first",
			"Start with the date.",
			"People and bots",
			"People type",
			"Bots suggest",
			"",
			"",
			"Questions",
			"",
		]);
		expect(slideMarks(after)).toEqual([[], [], [], []]);
	});

	it("suggests a new layout on the slide itself, adding the box it lacks", () => {
		const after = synced(
			suggested(
				live,
				slides(TITLE, GOALS.replace("layout: bullets", "layout: columns"), COLUMNS, QUESTIONS),
			),
		);

		const goals = after.child(1);
		expect(goals.attrs.layout).toBe("columns");
		expect(goals.marks.map((mark) => mark.attrs)).toMatchObject([
			{ type: "attr", attrName: "layout", previousValue: "bullets", newValue: "columns" },
		]);
		// The title and the list stay in their boxes, and the right column is proposed for adding.
		expect(
			goals
				.child(0)
				.children.map((box) => [box.textContent, box.marks.map((mark) => mark.type.name)]),
		).toEqual([
			["Goals", []],
			["Ship on FridayTell support first", []],
			["", ["insertion"]],
		]);
	});

	it("takes a slide added beside one that changed for a new slide, not for the one that changed", () => {
		const after = suggested(
			live,
			slides(
				TITLE,
				"<!-- layout: section -->\n\n## Plan",
				GOALS.replace("Friday", "Monday"),
				COLUMNS,
				QUESTIONS,
			),
		);

		expect(slideMarks(after)).toEqual([[], ["insertion"], [], [], []]);
		expect(shown(after)).toContain("Ship on [-Friday-][+Monday+]");
	});

	it("is blocked from a second layout for a slide while one suggested waits, as is an edit of it", () => {
		const waiting = suggested(
			live,
			slides(TITLE, GOALS, COLUMNS, QUESTIONS.replace("layout: section", "layout: bullets")),
		);
		const titled = slides(
			TITLE,
			GOALS,
			COLUMNS,
			QUESTIONS.replace("layout: section", "layout: title"),
		);

		expect(changedTo(waiting, titled, { suggestionId: "s2:agent:Planner" })).toBe("layoutPending");
		expect(changedTo(waiting, titled, "edit")).toBe("layoutPending");
	});

	it.each(MADE_OR_SUGGESTED)(
		"is blocked from the words of a slide whose new layout moves them while it waits, %s, and makes them once it is settled either way",
		(_, as) => {
			const inColumns = slides(
				TITLE,
				GOALS.replace("layout: bullets", "layout: columns"),
				COLUMNS,
				QUESTIONS,
			);
			const waiting = suggested(live, inColumns, "s1:person:Kim");
			const onMonday = (markdown: string) => markdown.replace("Friday", "Monday");

			expect(changedTo(waiting, onMonday(slides(TITLE, GOALS, COLUMNS, QUESTIONS)), as)).toBe(
				"layoutPending",
			);
			for (const [settled, reads] of [
				[accepted(waiting), inColumns],
				[undone(waiting), slides(TITLE, GOALS, COLUMNS, QUESTIONS)],
			] as const) {
				const after = accepted(changed(settled, onMonday(markdownForAgents(settled)), as));
				expect(asMarkdown(after)).toBe(asMarkdown(deck(onMonday(reads))));
			}
		},
	);

	it.each(MADE_OR_SUGGESTED)(
		"is blocked from a new layout for a slide holding somebody's suggestion, %s, until it is settled",
		(_, as) => {
			const kimsWords = suggested(
				live,
				slides(TITLE, GOALS.replace("Friday", "Monday"), COLUMNS, QUESTIONS),
				"s1:person:Kim",
			);
			const inColumns = slides(
				TITLE,
				GOALS.replace("layout: bullets", "layout: columns"),
				COLUMNS,
				QUESTIONS,
			);

			expect(changedTo(kimsWords, inColumns, as)).toBe("suggestionPending");
			// Once Kim's words are settled, the slide can be laid out anew, keeping them.
			const after = accepted(
				changed(accepted(kimsWords), inColumns.replace("Friday", "Monday"), as),
			);
			expect(asMarkdown(after)).toBe(asMarkdown(deck(inColumns.replace("Friday", "Monday"))));
		},
	);

	it.each(MADE_OR_SUGGESTED)(
		"changes a slide beside slides whose suggestions wait, %s, leaving those as they are",
		(_, as) => {
			const kimsWords = suggested(
				live,
				slides(TITLE, GOALS.replace("Friday", "Monday"), COLUMNS, QUESTIONS),
				"s1:person:Kim",
			);
			const waiting = suggested(
				kimsWords,
				slides(TITLE, GOALS, COLUMNS.replace("layout: columns", "layout: bullets"), QUESTIONS),
				"s2:person:Sam",
			);

			const after = changed(
				waiting,
				slides(
					TITLE,
					GOALS,
					COLUMNS,
					QUESTIONS.replace("layout: section", "layout: bullets").replace(
						"Questions",
						"Your questions",
					),
				),
				as,
			);

			expect(changedChildren(waiting, after)).toEqual([3]);
		},
	);

	it("is blocked inside a code block on a slide, which can't be marked", () => {
		const code = deck("<!-- layout: bullets -->\n\n## Run\n\n```\nship()\n```");

		expect(
			changedTo(code, "<!-- layout: bullets -->\n\n## Run\n\n```\nship(now)\n```", {
				suggestionId: "s1:agent:Planner",
			}),
		).toBe("unmarkable");
	});
});

describe("an agent's change to a deck holding what its markdown can't say", () => {
	const schema = liveDocumentSchema("slides");
	const node = (type: string, content?: Node | Node[], attrs?: Record<string, unknown>) =>
		schema.node(type, attrs ?? null, content);
	const paragraph = (text: string) => node("paragraph", schema.text(text));
	/** A slide holding words that markdown reads as a heading, and notes ending in spaces, which it drops. */
	const keptAsTyped = node(
		"slide",
		[
			node("slideBody", [
				node("slideBox", node("heading", schema.text("Kept as typed"), { level: 2 })),
				node("slideBox", paragraph("# is how a heading starts")),
			]),
			node("speakerNotes", paragraph("Pause here.   ")),
		],
		{ layout: "bullets" },
	);
	/** A new slide of every layout, each as the editor adds one, and the slide above. */
	const newSlides = node("doc", [
		...SLIDE_LAYOUTS.map((layout) => newSlide(schema, layout)),
		keptAsTyped,
	]);

	it.each(MADE_OR_SUGGESTED)("is unchanged when the agent changes nothing, %s", (_, as) => {
		// The markdown the agent reads doesn't read back as the deck.
		expect(deck(markdownForAgents(newSlides)).eq(newSlides)).toBe(false);

		expect(changedTo(newSlides, markdownForAgents(newSlides), as)).toBe("unchanged");
	});

	it.each(MADE_OR_SUGGESTED)("changes only the slide the agent changes, %s", (_, as) => {
		const titled = markdownForAgents(newSlides).replace(
			"<!-- layout: bullets -->\n\n##\n",
			"<!-- layout: bullets -->\n\n## Goals\n",
		);

		const after = changed(newSlides, titled, as);

		expect(after.childCount).toBe(newSlides.childCount);
		expect(changedChildren(newSlides, after)).toEqual([SLIDE_LAYOUTS.indexOf("bullets")]);
		expect(shown(accepted(after))).toContain("Goals");
	});
});

describe("an agent's change to a deck whose boxes somebody placed", () => {
	const PLACED_GOALS = [
		{ x: 80, y: 64, width: 800, height: 46 },
		{ x: 80, y: 142, width: 440, height: 300 },
	];
	/** The deck, the goals' boxes placed by hand, as only a person's editor places them. */
	const unplaced = deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS));
	const goals = unplaced.child(1);
	const live = unplaced.copy(
		unplaced.content.replaceChild(
			1,
			goals.type.create({ ...goals.attrs, placement: PLACED_GOALS }, goals.content),
		),
	);

	it("reads to the agent as markdown saying nothing of where the boxes are", () => {
		expect(placementOf(live.child(1))).toEqual(PLACED_GOALS);

		expect(markdownForAgents(live)).not.toContain("placement");
		expect(markdownForAgents(live)).toBe(
			markdownForAgents(deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS))),
		);
	});

	it.each(MADE_OR_SUGGESTED)(
		"keeps the boxes where they are on a slide whose words the agent changes, %s, however it is settled",
		(_, as) => {
			const after = synced(changed(live, markdownForAgents(live).replace("Friday", "Monday"), as));

			for (const settled of [accepted(after), undone(after)]) {
				expect(placementOf(settled.child(1))).toEqual(PLACED_GOALS);
			}
			expect(shown(accepted(after))).toContain("Ship on Monday");
		},
	);

	it.each(MADE_OR_SUGGESTED)(
		"places no box for a placement the agent writes, which is only words to the deck, %s",
		(_, as) => {
			const placing = markdownForAgents(live)
				.replace(
					"<!-- layout: bullets -->",
					"<!-- layout: bullets -->\n\n<!-- placement: 0 0 960 100; 0 100 960 440 -->",
				)
				.replace(
					"<!-- layout: section -->",
					"<!-- layout: section -->\n\n<!-- placement: 0 0 960 100; 0 100 960 440 -->",
				);

			const after = accepted(synced(changed(live, placing, as)));

			expect(after.children.map(placementOf)).toEqual([null, PLACED_GOALS, null, null]);
			expect(shown(after)).toContain("<!-- placement: 0 0 960 100; 0 100 960 440 -->");
		},
	);

	it.each([
		["into columns, with a box more", "columns"],
		["as a quote, with as many boxes", "quote"],
	] as const)("lays a placed slide out by the layout an agent gives it, %s", (_, layout) => {
		const relaidOut = markdownForAgents(live).replace("layout: bullets", `layout: ${layout}`);

		const edited = changed(live, relaidOut, "edit");

		expect(layoutOf(edited.child(1))).toBe(layout);
		expect(placementOf(edited.child(1))).toBeNull();
		expect(edited.child(1).attrs.placement).toBeNull();
	});

	it("lays a placed slide out by a layout the agent suggests once it is accepted, and puts its boxes back if it is undone", () => {
		const after = synced(
			suggested(live, markdownForAgents(live).replace("layout: bullets", "layout: quote")),
		);

		expect(placementOf(accepted(after).child(1))).toBeNull();
		const kept = undone(after).child(1);
		expect(layoutOf(kept)).toBe("bullets");
		expect(placementOf(kept)).toEqual(PLACED_GOALS);
	});
});

describe("an agent's change to a deck with a box somebody removed", () => {
	/** Whether each box of each slide is off it. */
	const offSlide = (node: Node) =>
		node.children.map((slide) => bodyOf(slide).children.map(isOffItsSlide));

	/** The deck, the right column of its slide in columns removed. */
	const live = withBoxRemoved(deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS)), 2, 2);
	const EVERY_BOX_ON = [
		[false, false],
		[false, false],
		[false, false, false],
		[false, false],
	];
	const RIGHT_COLUMN_OFF = [
		[false, false],
		[false, false],
		[false, false, true],
		[false, false],
	];

	it("reads to the agent as markdown in which the removed box is an empty box", () => {
		expect(offSlide(live)).toEqual(RIGHT_COLUMN_OFF);

		expect(markdownForAgents(live)).toBe(
			markdownForAgents(
				deck(
					slides(
						TITLE,
						GOALS,
						"<!-- layout: columns -->\n\n## People and bots\n\n<!-- box -->\n\n- People type\n\n<!-- box -->",
						QUESTIONS,
					),
				),
			),
		);
	});

	it.each(MADE_OR_SUGGESTED)(
		"removes no box for a removal the agent writes, which is only words to the deck, %s",
		(_, as) => {
			const unremoved = deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS));
			const removing = markdownForAgents(unremoved).replace("- Bots suggest", "<!-- removed -->");

			const after = accepted(synced(changed(unremoved, removing, as)));

			expect(
				after.children.flatMap((slide) => bodyOf(slide).children.map(isMarkedRemoved)),
			).toEqual(Array(9).fill(false));
			expect(shown(after)).toContain("<!-- removed -->");
		},
	);

	it.each(MADE_OR_SUGGESTED)(
		"keeps the removed box off its slide when the agent changes the words on it, %s, however it is settled",
		(_, as) => {
			const after = synced(
				changed(live, markdownForAgents(live).replace("People type", "People write"), as),
			);

			for (const settled of [accepted(after), undone(after)]) {
				expect(offSlide(settled)).toEqual(RIGHT_COLUMN_OFF);
			}
			expect(shown(accepted(after))).toContain("People write");
		},
	);

	describe("whose boxes somebody placed too", () => {
		const PLACED_GOALS = [
			{ x: 80, y: 64, width: 800, height: 46 },
			{ x: 80, y: 142, width: 440, height: 300 },
		];
		/** The deck, the goals' boxes placed and their title removed, as only a person's editor does. */
		const laidOutByHand = withSlidePlaced(
			withBoxRemoved(deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS)), 1, 0),
			1,
			PLACED_GOALS,
		);
		const inColumns = markdownForAgents(laidOutByHand).replace(
			"layout: bullets",
			"layout: columns",
		);

		it("is laid out by the layout an agent gives it, no longer placed and with every box back on it", () => {
			expect(offSlide(laidOutByHand)[1]).toEqual([true, false]);

			const edited = changed(laidOutByHand, inColumns, "edit");

			const relaidOut = edited.child(1);
			expect(layoutOf(relaidOut)).toBe("columns");
			expect(placementOf(relaidOut)).toBeNull();
			expect(bodyOf(relaidOut).children.map(isMarkedRemoved)).toEqual([false, false, false]);
		});

		it("is laid out by a layout an agent suggests, every box back on it, once that is accepted, and left as it was if it is undone", () => {
			const after = synced(suggested(laidOutByHand, inColumns));

			const kept = accepted(after).child(1);
			expect(layoutOf(kept)).toBe("columns");
			expect(placementOf(kept)).toBeNull();
			expect(bodyOf(kept).children.map(isMarkedRemoved)).toEqual([false, false, false]);
			const dropped = undone(after).child(1);
			expect(layoutOf(dropped)).toBe("bullets");
			expect(placementOf(dropped)).toEqual(PLACED_GOALS);
			expect(bodyOf(dropped).children.map(isOffItsSlide)).toEqual([true, false]);
		});
	});

	const writingInIt = markdownForAgents(live).replace(
		"- People type\n\n<!-- box -->",
		"- People type\n\n<!-- box -->\n\n- Bots write",
	);

	it("puts the box back on its slide when the agent writes in it, no longer marked removed", () => {
		const edited = changed(live, writingInIt, "edit");

		const rightColumn = bodyOf(edited.child(2)).child(2);
		expect(rightColumn.textContent).toBe("Bots write");
		expect(isMarkedRemoved(rightColumn)).toBe(false);
		expect(offSlide(edited)).toEqual(EVERY_BOX_ON);
	});

	it("shows the box on its slide while the agent's suggestion to write in it waits, and takes it off again if that is undone", () => {
		const after = synced(suggested(live, writingInIt));

		expect(offSlide(after)).toEqual(EVERY_BOX_ON);
		expect(shown(after)).toContain("[+Bots write+]");
		const kept = accepted(after);
		expect(bodyOf(kept.child(2)).child(2).textContent).toBe("Bots write");
		expect(isMarkedRemoved(bodyOf(kept.child(2)).child(2))).toBe(false);
		expect(offSlide(undone(after))).toEqual(RIGHT_COLUMN_OFF);
	});
});

describe("an agent's edit to a deck", () => {
	const live = deck(slides(TITLE, GOALS, COLUMNS, QUESTIONS));

	it.each([
		[
			"changes a slide's layout",
			slides(TITLE, GOALS.replace("layout: bullets", "layout: quote"), COLUMNS, QUESTIONS),
		],
		[
			"adds, removes and changes slides",
			slides(TITLE, QUESTIONS, COLUMNS.replace("Bots suggest", "Bots write")),
		],
	])("%s, reading as wanted", (_, wanted) => {
		const edited = changed(live, wanted, "edit");

		edited.check();
		expect(unfitted(edited)).toEqual([]);
		expect(asMarkdown(edited)).toBe(asMarkdown(deck(wanted)));
	});
});
