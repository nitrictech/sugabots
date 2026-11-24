import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import { fitSlideBody, layoutOf, newSlide } from "@sugabots/contracts/live-slides";
import { SLIDE_LAYOUTS, type SlideLayout } from "@sugabots/contracts/slides-markdown";
import type { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

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

/** The slides, by number from 1, whose frame doesn't hold what their layout says. */
const unfitted = (deck: Node) =>
	deck.children.flatMap((slide, index) => {
		const body = slide.child(0);
		return fitSlideBody(body, layoutOf(slide)) === body ? [] : [index + 1];
	});

/** What a slide's frame and notes hold, as lines of text, a column's starting with `|`. */
const linesOf = (slide: Node) => {
	const lines: string[] = [];
	slide.descendants((node) => {
		if (node.type.name === "slideColumn") lines.push("|");
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
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- column -->\n\n### People\n\n- Type in the page\n\n<!-- column -->\n\n### Bots\n\n1. Suggest changes\n2. Wait for a person",
	`<!-- layout: image -->\n\n## The chart\n\n<!-- column -->\n\nSales went <mark>up</mark>.\n\n<!-- column -->\n\n![The launch chart](${IMAGE})`,
	"<!-- layout: quote -->\n\n> Nothing a person writes is lost.\n\nThe team",
	"<!-- layout: table -->\n\n## Owners\n\n| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |\n| Launch | Marco<br>Aiko |",
	"<!-- layout: columns -->\n\n## Nothing in the columns yet\n\n<!-- column -->\n\n<!-- column -->",
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
				"Q3, for the whole team",
				"notes:",
				"Welcome everyone.",
				"Say the new pod's name.",
			],
			["Where we are", "notes:", ""],
			[
				"Goals",
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
			["Nothing a person writes is lost.", "The team", "notes:", ""],
			["Owners", "Milestone", "Owner", "Beta", "Priya", "Launch", "MarcoAiko", "notes:", ""],
			["Nothing in the columns yet", "|", "", "|", "", "notes:", ""],
			["", "notes:", ""],
		]);
	});

	it("writes the same markdown again from what it read, and reads that back as the same deck", () => {
		const deck = parsed(EVERY_LAYOUT);

		const once = written(deck);
		const again = parsed(once);

		expect(written(again)).toBe(once);
		expect(again.eq(deck)).toBe(true);
	});

	it("writes each slide's layout first, a comment before each column and the notes last", () => {
		const text = written(parsed(EVERY_LAYOUT));

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
		expect(slides[3]?.match(/<!-- column -->/g)).toHaveLength(2);
		// An empty slide is its layout alone, and no slide says it has notes when it has none.
		expect(slides[8]).toBe("<!-- layout: bullets -->");
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
			node("slide", [node("slideBody", paragraph()), node("speakerNotes", paragraph())], {
				layout: "title",
			}),
			node(
				"slide",
				[
					node("slideBody", [
						node("heading", schema.text("Two columns"), { level: 2 }),
						node("slideColumn", [paragraph(), paragraph("After an empty line")]),
						node("slideColumn", paragraph()),
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
					node("slideBody", [paragraph("A line"), paragraph(), paragraph()]),
					node("speakerNotes", [paragraph(), paragraph("After an empty line")]),
				],
				{ layout: "bullets" },
			),
			node(
				"slide",
				[
					node("slideBody", [
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
					node("slideBody", paragraph("Before")),
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
					node("slideBody", node("heading", schema.text("After"), { level: 2 })),
					node("speakerNotes", paragraph()),
				],
				{ layout: "section" },
			),
		]);

		const readBack = parsed(written(deck));

		expect(readBack.children.map(linesOf)).toEqual([
			["Before", "notes:", ...said.flatMap((text) => [text, text])],
			["After", "notes:", ""],
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
		["columns", "## Two\n\n<!-- column -->\n\nA\n\n<!-- column -->\n\nB", ["columns"]],
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
		expect(parsed(text).children.map((slide) => linesOf(slide)[0])).toEqual(titles);
	});

	it("keeps an empty slide written as its layout alone", () => {
		const deck = parsed(
			"<!-- layout: title -->\n\n# A\n\n---\n\n<!-- layout: bullets -->\n\n---\n\n<!-- layout: section -->\n\n## C",
		);

		expect(layouts(deck)).toEqual(["title", "bullets", "section"]);
		expect(linesOf(deck.child(1))).toEqual(["", "notes:", ""]);
	});

	it("reads markdown with nothing in it as one empty title slide", () => {
		for (const text of ["", "\n\n", "---"]) {
			const deck = parsed(text);
			expect(layouts(deck)).toEqual(["title"]);
			expect(linesOf(deck.child(0))).toEqual(["", "notes:", ""]);
		}
	});

	it("reads a line straight under text as making that text a heading, as markdown does", () => {
		const deck = parsed("Some text\n---\n\nMore");

		expect(deck.childCount).toBe(1);
		expect(deck.child(0).child(0).firstChild?.type.name).toBe("heading");
	});

	it.each([
		[
			"three columns, the third going into the second",
			"<!-- layout: columns -->\n\n## T\n\nBefore\n\n<!-- column -->\n\nA\n\n<!-- column -->\n\nB\n\n<!-- column -->\n\nC",
			["T", "|", "Before", "A", "|", "B", "C", "notes:", ""],
		],
		[
			"no columns, all of it going into the first",
			"<!-- layout: image -->\n\n## T\n\nWords",
			["T", "|", "Words", "|", "", "notes:", ""],
		],
		[
			"columns in a layout without, in one flow",
			"<!-- layout: bullets -->\n\n## T\n\n<!-- column -->\n\nA\n\n<!-- column -->\n\nB",
			["T", "A", "B", "notes:", ""],
		],
	])("fits %s to the slide's layout", (_, text, lines) => {
		expect(linesOf(parsed(text).child(0))).toEqual(lines);
	});

	it("reads a comment inside a quote as its text, and a line there as nothing", () => {
		const deck = parsed("> A quote\n>\n> <!-- notes: not these -->\n>\n> ***\n\nKim");

		expect(linesOf(deck.child(0))).toEqual([
			"A quote",
			"<!-- notes: not these -->",
			"Kim",
			"notes:",
			"",
		]);
	});

	it("keeps words written after a comment on its line", () => {
		const deck = parsed("<!-- layout: columns --><!-- column --> ### People\n\n- Type");

		expect(layouts(deck)).toEqual(["columns"]);
		expect(linesOf(deck.child(0))).toEqual(["|", "### People", "Type", "|", "", "notes:", ""]);
	});
});

describe("a slide's layout", () => {
	/** The frame of a slide in two columns, under a title. */
	const inColumns = () =>
		parsed(
			"<!-- layout: columns -->\n\n## People and bots\n\n<!-- column -->\n\n- People type\n\n<!-- column -->\n\n- Bots suggest",
		)
			.child(0)
			.child(0);

	it.each(SLIDE_LAYOUTS)(
		"changed to %s and back keeps everything the slide holds, and fits",
		(layout) => {
			const body = inColumns();

			const changed = fitSlideBody(body, layout);
			const back = fitSlideBody(changed, "columns");

			expect(changed.textContent).toBe(body.textContent);
			expect(back.textContent).toBe(body.textContent);
			expect(fitSlideBody(changed, layout)).toBe(changed);
			changed.check();
			back.check();
		},
	);

	it("leaves the slide as it was when it fits already", () => {
		const body = inColumns();

		expect(fitSlideBody(body, "columns")).toBe(body);
	});
});
