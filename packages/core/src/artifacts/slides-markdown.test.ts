import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import {
	fitSlideBody,
	isMarkedRemoved,
	laidOutAnew,
	layoutOf,
	newSlide,
	placementOf,
	SLIDE_BOX,
} from "@sugabots/contracts/live-slides";
import {
	type Frame,
	placementIn,
	roomBottom,
	SLIDE_LAYOUTS,
	type SlideLayout,
} from "@sugabots/contracts/slides-markdown";
import type { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { titleOf } from "./slides.test-support.ts";

/*
 * A deck's markdown, read and written as the API does (see `live.ts`): what
 * bots read and write, and what every version keeps.
 */

const schema = liveDocumentSchema("slides");

/** `text` as a deck, which must be one its schema holds, every slide fitting its layout. */
function parsed(text: string): Node {
	const deck = liveDocumentFromMarkdown("slides", text);
	deck.check();
	expect(unfitted(deck)).toEqual([]);
	return deck;
}

const written = (deck: Node) => markdownOfLiveDocument(deck);

const layouts = (deck: Node) => deck.children.map(layoutOf);

const node = (type: string, content?: Node | Node[], attrs?: Record<string, unknown>) =>
	schema.node(type, attrs ?? null, content);

const paragraph = (text?: string) => node("paragraph", text ? schema.text(text) : undefined);

const heading = (level: number, text?: string) =>
	node("heading", text ? schema.text(text) : undefined, { level });

const box = (...blocks: Node[]) => node(SLIDE_BOX, blocks);

/** The slides, by number from 1, whose body doesn't hold what their layout says. */
const unfitted = (deck: Node) =>
	deck.children.flatMap((slide, index) => {
		const body = slide.child(0);
		return fitSlideBody(body, layoutOf(slide)) === body ? [] : [index + 1];
	});

/** What a slide's body and notes hold, as lines of text, each box after the first starting with `|`. */
const linesOf = (slide: Node) => {
	const lines: string[] = [];
	slide.descendants((node, _pos, _parent, index) => {
		if (node.type.name === SLIDE_BOX && index > 0) lines.push("|");
		if (node.type.name === "speakerNotes") lines.push("notes:");
		if (node.isTextblock) lines.push(node.textContent);
		return !node.isTextblock;
	});
	return lines;
};

const IMAGE = `/api/pods/0199a3a0-0000-7000-8000-000000000001/artifacts/0199a3a0-0000-7000-8000-000000000002/images/${"a".repeat(64)}`;

/** A deck with a slide of every layout, and slides with nothing in them. */
const EVERY_LAYOUT = [
	"<!-- layout: title -->\n\n# Launch review\n\nQ3, for the whole team\n\n<!-- notes: Welcome everyone.\n\nSay the **new** pod's name. -->",
	"<!-- layout: section -->\n\n## Where we are",
	"<!-- layout: bullets -->\n\n## Goals\n\n- Ship *live* slides\n  - with suggestions\n  - and notes\n- Keep `markdown` as it is\n- Mark x<sup>2</sup> and <u>this</u>",
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- box -->\n\n### People\n\n- Type in the page\n\n<!-- box -->\n\n### Bots\n\n1. Suggest changes\n2. Wait for a person",
	`<!-- layout: image -->\n\n## The chart\n\n<!-- box -->\n\nSales went <mark>up</mark>.\n\n<!-- box -->\n\n![The launch chart](${IMAGE})`,
	"<!-- layout: quote -->\n\n> Nothing a person writes is lost.\n\nThe team",
	"<!-- layout: table -->\n\n## Owners\n\n| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |\n| Launch | Marco<br>Aiko |",
	"<!-- layout: columns -->\n\n## Nothing in the columns yet\n\n<!-- box -->\n\n<!-- box -->",
	"<!-- layout: bullets -->",
].join("\n\n---\n\n");

describe("a deck's markdown", () => {
	it("reads a slide of every layout, each holding what it was written with", () => {
		const deck = parsed(EVERY_LAYOUT);

		expect(layouts(deck)).toEqual([
			"title",
			"section",
			"bullets",
			"columns",
			"image",
			"quote",
			"table",
			"columns",
			"bullets",
		]);
		expect(deck.children.map(linesOf)).toEqual([
			[
				"Launch review",
				"|",
				"Q3, for the whole team",
				"notes:",
				"Welcome everyone.",
				"Say the new pod's name.",
			],
			// A section break with no label over its title.
			["", "|", "Where we are", "notes:", ""],
			[
				"Goals",
				"|",
				"Ship live slides",
				"with suggestions",
				"and notes",
				"Keep markdown as it is",
				"Mark x2 and this",
				"notes:",
				"",
			],
			[
				"People and bots",
				"|",
				"People",
				"Type in the page",
				"|",
				"Bots",
				"Suggest changes",
				"Wait for a person",
				"notes:",
				"",
			],
			["The chart", "|", "Sales went up.", "|", "", "notes:", ""],
			["Nothing a person writes is lost.", "|", "The team", "notes:", ""],
			["Owners", "|", "Milestone", "Owner", "Beta", "Priya", "Launch", "MarcoAiko", "notes:", ""],
			["Nothing in the columns yet", "|", "", "|", "", "notes:", ""],
			["", "|", "", "notes:", ""],
		]);
	});

	it("writes the same markdown again from what it read, and reads that back as the same deck", () => {
		const deck = parsed(EVERY_LAYOUT);

		const once = written(deck);
		const again = parsed(once);

		expect(written(again)).toBe(once);
		expect(again.eq(deck)).toBe(true);
	});

	it("writes each slide's layout first, a comment before each box after the first and the notes last", () => {
		const deck = parsed(EVERY_LAYOUT);
		const text = written(deck);

		const slides = text.split("\n\n---\n\n");
		expect(slides.map((slide) => slide.split("\n")[0])).toEqual(
			[
				"title",
				"section",
				"bullets",
				"columns",
				"image",
				"quote",
				"table",
				"columns",
				"bullets",
			].map((layout) => `<!-- layout: ${layout} -->`),
		);
		expect(slides[0]).toMatch(
			/<!-- notes: Welcome everyone\.\n\nSay the \*\*new\*\* pod's name\. -->$/,
		);
		expect(slides.map((slide) => slide.match(/<!-- box -->/g)?.length)).toEqual([
			1, 1, 1, 2, 2, 1, 1, 2, 1,
		]);
		expect(slides[1]).toBe("<!-- layout: section -->\n\n<!-- box -->\n\n## Where we are");
		// An empty slide is its layout and its empty boxes, and no slide says it has notes when it has none.
		expect(slides[8]).toBe("<!-- layout: bullets -->\n\n##\n\n<!-- box -->");
		expect(text.match(/<!-- notes:/g)).toHaveLength(1);
	});

	it("never writes a line of text straight above the line between two slides", () => {
		const text = written(parsed(EVERY_LAYOUT));

		expect(text).not.toMatch(/\S\n---/);
	});

	it.each(SLIDE_LAYOUTS)(
		"reads a new %s slide back as the same slide, its title, list and regions still empty",
		(layout) => {
			const deck = node("doc", [newSlide(schema, layout), newSlide(schema, layout)]);
			deck.check();

			const readBack = parsed(written(deck));

			expect(readBack.eq(deck)).toBe(true);
		},
	);

	it("reads a deck written in the editor back as the same deck: empty regions, empty lines, notes and words that look like a rule", () => {
		const bold = schema.marks.bold?.create();
		const overALine = (text: string) =>
			node("paragraph", [schema.text("Over a line"), node("hardBreak"), schema.text(text)]);
		const deck = node("doc", [
			node(
				"slide",
				[node("slideBody", [box(heading(1)), box(paragraph())]), node("speakerNotes", paragraph())],
				{ layout: "title" },
			),
			node(
				"slide",
				[
					node("slideBody", [
						box(heading(2, "Two columns")),
						box(paragraph(), paragraph("After an empty line")),
						box(paragraph()),
					]),
					node("speakerNotes", [
						paragraph("First"),
						paragraph(),
						node("paragraph", schema.text("Then bold", bold ? [bold] : [])),
						paragraph("Text with --> in it, and <!-- too"),
					]),
				],
				{ layout: "columns" },
			),
			node(
				"slide",
				[
					node("slideBody", [
						box(heading(2, "A title"), paragraph("And a line under it")),
						box(paragraph("A line"), paragraph(), paragraph()),
					]),
					node("speakerNotes", [paragraph(), paragraph("After an empty line")]),
				],
				{ layout: "bullets" },
			),
			node(
				"slide",
				[
					node("slideBody", [
						box(heading(2)),
						box(
							paragraph("---"),
							paragraph("***"),
							paragraph("___"),
							paragraph("- - -"),
							paragraph("* * *"),
							paragraph("-"),
							paragraph("==="),
							overALine("---"),
							overALine("==="),
							node("bulletList", [
								node("listItem", paragraph("---")),
								node("listItem", paragraph("- - -")),
							]),
							node("blockquote", paragraph("---")),
						),
					]),
					node("speakerNotes", [paragraph("---"), paragraph("- - -")]),
				],
				{ layout: "bullets" },
			),
		]);
		deck.check();

		const readBack = parsed(written(deck));

		expect(readBack.eq(deck)).toBe(true);
		expect(written(readBack)).toBe(written(deck));
	});

	it("keeps the notes comment whole, and the notes as they were, when they hold `-->` or what it is written as, in code or not", () => {
		const code = schema.marks.code?.create();
		const said = ["a-->b", "a--&gt;b", "a--&amp;b", "a--\\>b", "a--\\b", "a--\\\\b"];
		const deck = node("doc", [
			node(
				"slide",
				[
					node("slideBody", [box(heading(2)), box(paragraph("Before"))]),
					node(
						"speakerNotes",
						said.flatMap((text) => [
							paragraph(text),
							node("paragraph", schema.text(text, code ? [code] : [])),
						]),
					),
				],
				{ layout: "bullets" },
			),
			node(
				"slide",
				[
					node("slideBody", [box(paragraph()), box(heading(2, "After"))]),
					node("speakerNotes", paragraph()),
				],
				{ layout: "section" },
			),
		]);

		const readBack = parsed(written(deck));

		expect(readBack.children.map(linesOf)).toEqual([
			["", "|", "Before", "notes:", ...said.flatMap((text) => [text, text])],
			["", "|", "After", "notes:", ""],
		]);
		expect(readBack.eq(deck)).toBe(true);
	});

	it.each<[string, string, SlideLayout[]]>([
		["a title slide, first", "# Launch\n\nQ3 plan", ["title"]],
		[
			"a heading alone after the first, as a section",
			"# Launch\n\n---\n\n## Part two",
			["title", "section"],
		],
		[
			"a heading over a long paragraph, as bullets",
			`# Launch\n\n${"Words ".repeat(30)}`,
			["bullets"],
		],
		["a list", "## Goals\n\n- One\n- Two", ["bullets"]],
		["a quote with whose it is", "> Ship it.\n\nKim", ["quote"]],
		["a table", "## Owners\n\n| A | B |\n| - | - |\n| 1 | 2 |", ["table"]],
		["columns", "## Two\n\n<!-- box -->\n\nA\n\n<!-- box -->\n\nB", ["columns"]],
		[
			"a layout this version doesn't know",
			"<!-- layout: timeline -->\n\n## Goals\n\n- One",
			["bullets"],
		],
		["a layout written loosely", "<!-- Layout:Quote -->\n\n> Ship it.", ["quote"]],
	])("guesses the layout of %s", (_, text, expected) => {
		expect(layouts(parsed(text))).toEqual(expected);
	});

	it.each([
		[
			"leading, trailing and repeated lines",
			"---\n\n---\n\n# A\n\n---\n\n\n\n---\n\n## B\n\n---\n",
			["A", "B"],
		],
		["thematic breaks of every kind", "# A\n\n***\n\n## B\n\n___\n\n## C", ["A", "B", "C"]],
		[
			"a layout comment where the line was left out",
			"<!-- layout: title -->\n# A\n<!-- layout: bullets -->\n## B\n- x",
			["A", "B"],
		],
	])("makes no empty slide from %s", (_, text, titles) => {
		expect(parsed(text).children.map(titleOf)).toEqual(titles);
	});

	it("keeps an empty slide written as its layout alone", () => {
		const deck = parsed(
			"<!-- layout: title -->\n\n# A\n\n---\n\n<!-- layout: bullets -->\n\n---\n\n<!-- layout: section -->\n\n## C",
		);

		expect(layouts(deck)).toEqual(["title", "bullets", "section"]);
		expect(linesOf(deck.child(1))).toEqual(["", "|", "", "notes:", ""]);
	});

	it("reads markdown with nothing in it as one empty title slide", () => {
		for (const text of ["", "\n\n", "---"]) {
			const deck = parsed(text);
			expect(layouts(deck)).toEqual(["title"]);
			expect(linesOf(deck.child(0))).toEqual(["", "|", "", "notes:", ""]);
		}
	});

	it("reads a line straight under text as making that text a heading, as markdown does", () => {
		const deck = parsed("Some text\n---\n\nMore");

		expect(deck.childCount).toBe(1);
		expect(titleOf(deck.child(0))).toBe("Some text");
	});

	it.each([
		[
			"a fourth box, which goes into the third",
			"<!-- layout: columns -->\n\n## T\n\nBefore\n\n<!-- box -->\n\nA\n\n<!-- box -->\n\nB\n\n<!-- box -->\n\nC",
			["T", "Before", "|", "A", "|", "B", "C", "notes:", ""],
		],
		[
			"no boxes, all of it but the title going into the second",
			"<!-- layout: image -->\n\n## T\n\nWords",
			["T", "|", "Words", "|", "", "notes:", ""],
		],
		[
			"more boxes than its layout has, the extra one's words joining the last",
			"<!-- layout: bullets -->\n\n## T\n\n<!-- box -->\n\nA\n\n<!-- box -->\n\nB",
			["T", "|", "A", "B", "notes:", ""],
		],
		[
			"an empty box among the extra ones, which holds nothing to keep",
			"<!-- layout: bullets -->\n\n## T\n\n<!-- box -->\n\n<!-- box -->\n\nB",
			["T", "|", "B", "notes:", ""],
		],
		[
			"fewer boxes than its layout has, the missing one added empty",
			"<!-- layout: columns -->\n\n## T\n\n<!-- box -->\n\nA",
			["T", "|", "A", "|", "", "notes:", ""],
		],
		[
			"an empty first box, given an empty title",
			"<!-- layout: columns -->\n\n<!-- box -->\n\nA\n\n<!-- box -->\n\nB",
			["", "|", "A", "|", "B", "notes:", ""],
		],
	])("fits %s to the slide's layout", (_, text, lines) => {
		expect(linesOf(parsed(text).child(0))).toEqual(lines);
	});

	it.each<[SlideLayout, string, string[]]>([
		["title", "# T\n\nUnder it", ["T", "|", "Under it"]],
		["title", "Under it", ["", "|", "Under it"]],
		["bullets", "## T\n\n- One\n- Two", ["T", "|", "One", "Two"]],
		["bullets", "- One\n\n## Not first", ["", "|", "One", "Not first"]],
		["columns", "## T\n\nA\n\n- B", ["T", "|", "A", "B", "|", ""]],
		["image", "## T\n\nWords", ["T", "|", "Words", "|", ""]],
		["section", "Part 2\n\n## T\n\nUnder it", ["Part 2", "|", "T", "Under it"]],
		["section", "## T", ["", "|", "T"]],
		["section", "Part 2", ["Part 2", "|", ""]],
		["quote", "> Ship it.\n\nKim", ["Ship it.", "|", "Kim"]],
		["quote", "Kim", ["", "|", "Kim"]],
		["table", "## T\n\n| A |\n| - |\n| 1 |", ["T", "|", "A", "1"]],
	])("shares out a %s slide written without boxes, from `%s`", (layout, content, lines) => {
		const slide = parsed(`<!-- layout: ${layout} -->\n\n${content}`).child(0);

		expect(linesOf(slide).slice(0, -2)).toEqual(lines);
	});

	it.each<[SlideLayout, string, number | undefined]>([
		["title", "heading", 1],
		["bullets", "heading", 2],
		["columns", "heading", 2],
		["image", "heading", 2],
		["table", "heading", 2],
		["section", "paragraph", undefined],
		["quote", "blockquote", undefined],
	])(
		"gives a %s slide's empty first box %s to type in, as a new slide's",
		(layout, kind, level) => {
			const slide = parsed(`<!-- layout: ${layout} -->`).child(0);

			const first = slide.child(0).child(0);
			expect(first.childCount).toBe(1);
			expect(first.firstChild?.type.name).toBe(kind);
			expect(first.firstChild?.attrs.level).toBe(level);
		},
	);

	it("reads a comment inside a quote as its text, and a line there as nothing", () => {
		const deck = parsed("> A quote\n>\n> <!-- notes: not these -->\n>\n> ***\n\nKim");

		expect(linesOf(deck.child(0))).toEqual([
			"A quote",
			"<!-- notes: not these -->",
			"|",
			"Kim",
			"notes:",
			"",
		]);
	});

	it("keeps words written after a comment on its line", () => {
		const deck = parsed("<!-- layout: columns --><!-- box --> ### People\n\n- Type");

		expect(layouts(deck)).toEqual(["columns"]);
		expect(linesOf(deck.child(0))).toEqual(["", "|", "### People", "Type", "|", "", "notes:", ""]);
	});
});

describe("a slide's placement", () => {
	const GOALS =
		"<!-- layout: bullets -->\n\n## Goals\n\nFor the quarter\n\n<!-- box -->\n\n- Ship it";
	const FRAMES = [
		{ x: 80, y: 64, width: 800, height: 46 },
		{ x: 80, y: 142, width: 440, height: 300 },
	];

	it("is never read from markdown: a comment saying where boxes are, or which were removed, is only its words", () => {
		const placing = "<!-- placement: 80 64 800 46; 80 142 440 300 -->";
		const removing = "<!-- removed: 2 -->";
		const deck = parsed(
			GOALS.replace(
				"<!-- layout: bullets -->",
				`<!-- layout: bullets -->\n\n${placing}\n\n${removing}`,
			),
		);

		expect(placementOf(deck.child(0))).toBeNull();
		expect(deck.child(0).child(0).children.map(isMarkedRemoved)).toEqual([false, false]);
		expect(linesOf(deck.child(0))).toEqual([
			placing,
			removing,
			"Goals",
			"For the quarter",
			"|",
			"Ship it",
			"notes:",
			"",
		]);
	});

	it("is never written as markdown, nor which boxes were removed", () => {
		const deck = parsed(GOALS);
		const slide = deck.child(0);
		const body = slide.child(0);
		const removedBody = body.copy(
			body.content.replaceChild(1, node(SLIDE_BOX, paragraph(), { removed: true })),
		);
		const laidOutByHand = deck.copy(
			deck.content.replaceChild(
				0,
				slide.type.create(
					{ ...slide.attrs, placement: FRAMES },
					slide.content.replaceChild(0, removedBody),
				),
			),
		);
		expect(placementOf(laidOutByHand.child(0))).toEqual(FRAMES);

		expect(written(laidOutByHand)).toBe(
			"<!-- layout: bullets -->\n\n## Goals\n\nFor the quarter\n\n<!-- box -->",
		);
	});

	it("is a frame for each box of the slide's layout, in whole pixels, within the slide", () => {
		const frame = { x: 0, y: 0, width: 960, height: 540 };

		expect(placementIn([frame, frame], "bullets")).toEqual([frame, frame]);
		expect(placementIn([frame, frame], "columns")).toBeNull();
		expect(placementIn([frame, { ...frame, x: 1 }], "bullets")).toBeNull();
		expect(placementIn([frame, { ...frame, width: "960" }], "bullets")).toBeNull();
		expect(placementIn([frame, { x: 0, y: 0, width: 960 }], "bullets")).toBeNull();
		expect(placementIn([frame, null], "bullets")).toBeNull();
		expect(placementIn("0 0 960 540; 0 0 960 540", "bullets")).toBeNull();
		expect(placementIn(null, "bullets")).toBeNull();
	});
});

describe("the room a placed box has down its slide", () => {
	const box: Frame = { x: 80, y: 64, width: 400, height: 100 };

	it.each<[string, Frame[], boolean[], number]>([
		["the slide's bottom margin, with no box below it", [box], [true], 476],
		[
			"the top of a box below it that shares some of its width",
			[box, { x: 400, y: 300, width: 300, height: 100 }],
			[true, true],
			300,
		],
		[
			"the top of the nearest of the boxes below it",
			[box, { x: 80, y: 400, width: 400, height: 60 }, { x: 300, y: 250, width: 100, height: 60 }],
			[true, true, true],
			250,
		],
		[
			"the slide's bottom margin, past a box below it that shares none of its width",
			[box, { x: 480, y: 300, width: 300, height: 100 }],
			[true, true],
			476,
		],
		[
			"the slide's bottom margin, past a box above it",
			[box, { x: 80, y: 20, width: 400, height: 30 }],
			[true, true],
			476,
		],
		[
			"the slide's bottom margin, past a box below it that is off the slide",
			[box, { x: 80, y: 300, width: 400, height: 100 }],
			[true, false],
			476,
		],
		[
			"its own frame's bottom, when a box below starts inside its frame",
			[
				{ x: 80, y: 64, width: 400, height: 300 },
				{ x: 80, y: 200, width: 400, height: 100 },
			],
			[true, true],
			364,
		],
		[
			"its own frame's bottom, when its frame reaches past the bottom margin",
			[{ x: 80, y: 440, width: 400, height: 100 }],
			[true],
			540,
		],
	])("ends at %s", (_, frames, shown, bottom) => {
		expect(roomBottom(frames, shown, 0)).toBe(bottom);
	});
});

describe("a slide's layout", () => {
	/** A slide in two columns, under a title. */
	const inColumns = () =>
		parsed(
			"<!-- layout: columns -->\n\n## People and bots\n\n<!-- box -->\n\n- People type\n\n<!-- box -->\n\n- Bots suggest",
		).child(0);

	/** What each box of `slide` holds, as its text. */
	const boxesOf = (slide: Node) => slide.child(0).children.map((each) => each.textContent);

	it.each<[SlideLayout, string[]]>([
		["title", ["People and bots", "People typeBots suggest"]],
		["bullets", ["People and bots", "People typeBots suggest"]],
		["image", ["People and bots", "People type", "Bots suggest"]],
		// A section break's label is left empty, and the columns go under its title.
		["section", ["", "People and botsPeople typeBots suggest"]],
		["quote", ["People and bots", "People typeBots suggest"]],
		["table", ["People and bots", "People typeBots suggest"]],
	])(
		"changed to %s keeps the title the title, the other boxes going in order to the boxes left",
		(layout, boxes) => {
			expect(boxesOf(laidOutAnew(inColumns(), layout))).toEqual(boxes);
		},
	);

	it("changed to a layout with more boxes, adds the boxes it lacks empty", () => {
		const inBullets = parsed(
			"<!-- layout: bullets -->\n\n## Goals\n\n<!-- box -->\n\n- Ship it",
		).child(0);

		const changed = laidOutAnew(inBullets, "columns");

		expect(boxesOf(changed)).toEqual(["Goals", "Ship it", ""]);
		expect(changed.child(0).child(0).eq(inBullets.child(0).child(0))).toBe(true);
		expect(changed.child(0).child(1).eq(inBullets.child(0).child(1))).toBe(true);
	});

	it.each(SLIDE_LAYOUTS)(
		"changed to %s and back keeps everything the slide holds, and fits",
		(layout) => {
			const slide = inColumns();

			const changed = laidOutAnew(slide, layout);
			const back = laidOutAnew(changed, "columns");

			expect(changed.textContent).toBe(slide.textContent);
			expect(back.textContent).toBe(slide.textContent);
			expect(fitSlideBody(changed.child(0), layout)).toBe(changed.child(0));
			changed.check();
			back.check();
		},
	);

	/** What each box of `slide` holds, by the names of its blocks. */
	const blocksOf = (slide: Node) =>
		slide.child(0).children.map((each) => each.children.map((block) => block.type.name));

	const GOALS = "<!-- layout: bullets -->\n\n## Goals\n\n<!-- box -->\n\n- Ship it";

	it("changed from bullets to a section break keeps the heading as its title, with what was under it, the label left empty", () => {
		const section = laidOutAnew(parsed(GOALS).child(0), "section");

		expect(boxesOf(section)).toEqual(["", "GoalsShip it"]);
		expect(blocksOf(section)).toEqual([["paragraph"], ["heading", "bulletList"]]);
	});

	it("changed from a section break to bullets and back is the slide it was, either way round", () => {
		const inBullets = parsed(GOALS).child(0);
		const section = laidOutAnew(inBullets, "section");

		const bullets = laidOutAnew(section, "bullets");

		expect(bullets.eq(inBullets)).toBe(true);
		expect(laidOutAnew(bullets, "section").eq(section)).toBe(true);
	});

	it("changed to a layout of as many boxes and back keeps a right column the right one when the left holds nothing", () => {
		const rightOnly = parsed(
			"<!-- layout: columns -->\n\n## People and bots\n\n<!-- box -->\n\n<!-- box -->\n\n- Bots suggest",
		).child(0);

		const withImage = laidOutAnew(rightOnly, "image");

		expect(boxesOf(withImage)).toEqual(["People and bots", "", "Bots suggest"]);
		expect(boxesOf(laidOutAnew(withImage, "columns"))).toEqual([
			"People and bots",
			"",
			"Bots suggest",
		]);
	});

	it("leaves the slide's body as it was when it fits already", () => {
		const body = inColumns().child(0);

		expect(fitSlideBody(body, "columns")).toBe(body);
	});
});
