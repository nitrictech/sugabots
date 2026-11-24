import type { LiveArtifactKind } from "@sugabots/contracts/artifacts";
import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import type { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

/*
 * A live document's markdown, read and written as the API does (see
 * `live.ts`): what bots read and write, and what every version keeps.
 */

const schema = liveDocumentSchema("document");

/** `text` as a live document, which must be one its schema holds. */
function parsed(text: string): Node {
	const document = liveDocumentFromMarkdown("document", text);
	document.check();
	return document;
}

const written = (document: Node) => markdownOfLiveDocument(document).trim();

const IMAGE = `/api/pods/0199a3a0-0000-7000-8000-000000000001/artifacts/0199a3a0-0000-7000-8000-000000000002/images/${"a".repeat(64)}`;

describe("a live document's markdown", () => {
	it("writes the marks markdown has no sign for as the tags that draw them, and reads them back", () => {
		const text = "x<sup>2</sup>, H<sub>2</sub>O, <mark>launch day</mark> and <u>firm</u>";
		const marked: Record<string, string> = {};
		parsed(text).descendants((node) => {
			for (const mark of node.marks) marked[mark.type.name] = node.text ?? "";
		});

		expect(marked).toEqual({
			superscript: "2",
			subscript: "2",
			highlight: "launch day",
			underline: "firm",
		});
		expect(written(parsed(text))).toBe(text);
	});

	it("keeps a table with its header row", () => {
		const table = "| Milestone | Owner |\n| --------- | ----- |\n| Beta      | Priya |";

		const document = parsed(table);

		const rows = document.firstChild;
		expect(rows?.child(0).firstChild?.type.name).toBe("tableHeader");
		expect(rows?.child(1).firstChild?.type.name).toBe("tableCell");
		expect(written(document)).toBe(table);
	});

	it("keeps every word of a cell holding what a markdown table can't, as lines of one paragraph", () => {
		const node = (type: string, content: Node | Node[]) => schema.node(type, null, content);
		const line = (text: string) => node("paragraph", schema.text(text));
		const richer = node("doc", [
			node("table", [
				node("tableRow", [node("tableHeader", line("Notes")), node("tableHeader", line("Steps"))]),
				node("tableRow", [
					node("tableCell", [line("First thought"), line("Second thought")]),
					node(
						"tableCell",
						node("bulletList", [
							node("listItem", line("Draft")),
							node("listItem", line("Review | sign off")),
						]),
					),
				]),
			]),
		]);

		const readBack = parsed(written(richer));

		const cells: string[] = [];
		readBack.descendants((node) => {
			if (node.type.name === "tableCell")
				cells.push(node.textBetween(0, node.content.size, "\n", "\n"));
		});
		expect(cells).toEqual(["First thought\nSecond thought", "- Draft\n- Review | sign off"]);
		expect(written(parsed(written(readBack)))).toBe(written(readBack));
	});

	it.each([
		["alone on its line", `![The launch chart](${IMAGE})`],
		["beside words", `Ship ![The launch chart](${IMAGE}) on Friday.`],
		["in a list", `- ![The launch chart](${IMAGE})`],
		["in a heading", `# Plan ![The launch chart](${IMAGE})`],
	])("reads an image %s as one the document holds, and writes it back", (_, text) => {
		const document = parsed(text);

		let image: Node | undefined;
		document.descendants((node) => {
			if (node.type.name === "image") image = node;
		});
		expect(image?.attrs).toMatchObject({ src: IMAGE, alt: "The launch chart" });
		expect(written(document)).toBe(text);
	});

	it("reads an image in a table cell as one the document holds", () => {
		const table = `| Chart |\n| --- |\n| ![The launch chart](${IMAGE}) |`;

		const document = parsed(table);

		expect(written(document)).toContain(`| ![The launch chart](${IMAGE}) |`);
	});

	it("keeps an image's title", () => {
		const text = `![The launch chart](${IMAGE} "Launch chart, May")`;

		expect(written(parsed(text))).toBe(text);
	});

	it.each([
		["its own", `[![The launch chart](${IMAGE})](https://example.com/chart)`, IMAGE, null],
		[
			"from outside, with titles",
			'[![A tracker](https://tracker.example/pixel.png "Pixel")](https://example.com/chart "Chart")',
			"https://tracker.example/pixel.png",
			"Chart",
		],
	])("keeps the link around an image %s, and writes it back", (_, text, src, linkTitle) => {
		const document = parsed(text);

		const images: Node[] = [];
		document.descendants((node) => {
			if (node.type.name === "image") images.push(node);
		});
		expect(images.map((image) => image.attrs)).toMatchObject([
			{ src, link: "https://example.com/chart", linkTitle },
		]);
		expect(written(document)).toBe(text);
	});

	it("keeps a link holding words and an image on both", () => {
		const document = parsed(`[Read ![The launch chart](${IMAGE}) here](https://example.com/chart)`);

		const linked: string[] = [];
		document.descendants((node) => {
			if (node.type.name === "image") linked.push(`image to ${node.attrs.link}`);
			const mark = node.marks.find((candidate) => candidate.type.name === "link");
			if (node.isText && mark) linked.push(`"${node.text}" to ${mark.attrs.href}`);
		});
		expect(linked).toEqual([
			'"Read " to https://example.com/chart',
			"image to https://example.com/chart",
			'" here" to https://example.com/chart',
		]);
		expect(written(parsed(written(document)))).toBe(written(document));
	});

	it("reads any other HTML as the text it is", () => {
		const text = [
			'Before <img src="https://tracker.example/pixel.png"> and <b>bold</b> after.',
			"<table><tr><td>x</td></tr></table>",
		].join("\n\n");

		const document = parsed(text);

		const kinds = new Set<string>();
		document.descendants((node) => {
			kinds.add(node.type.name);
			for (const mark of node.marks) kinds.add(mark.type.name);
		});
		expect([...kinds].sort()).toEqual(["paragraph", "text"]);
		expect(document.textContent).toBe(
			'Before <img src="https://tracker.example/pixel.png"> and <b>bold</b> after.<table><tr><td>x</td></tr></table>',
		);
	});

	it("keeps an empty heading, written as its marks", () => {
		const document = schema.node("doc", null, [
			schema.node("heading", { level: 2 }),
			schema.node("paragraph", null, schema.text("Text")),
		]);

		expect(written(document)).toBe("##\n\nText");
		expect(parsed(written(document)).eq(document)).toBe(true);
	});

	it("reads words that look like a rule, or like the underline of a heading, back as those words", () => {
		const line = (text: string) => schema.node("paragraph", null, schema.text(text));
		const overALine = (text: string) =>
			schema.node("paragraph", null, [
				schema.text("Over a line"),
				schema.node("hardBreak"),
				schema.text(text),
			]);
		const document = schema.node("doc", null, [
			line("---"),
			line("- - -"),
			line("***"),
			line("___"),
			line("-"),
			line("==="),
			overALine("---"),
			overALine("==="),
			schema.node("bulletList", null, schema.node("listItem", null, line("---"))),
		]);

		expect(parsed(written(document)).eq(document)).toBe(true);
	});
});

describe("markdown a live document's schema has no place for", () => {
	/** Markdown each kind's markdown reader reads as nodes their schema can't hold as they are. */
	const UNFITTING: [label: string, markdown: string][] = [
		["a quote holding nothing", ">"],
		["a numbered item holding nothing", "1."],
		["a numbered item holding nothing after another", "1. Plan\n2. "],
		["a task list", "- [ ] Book the room\n- [x] Send invites"],
		["a task list with a task in a task", "- [ ] Book the room\n  - [x] Ask the venue"],
		["a quote holding only a rule", "> ---"],
		["a list item holding an empty quote", "- >"],
		["bold code", "**`launch.ts`**"],
		["code in a link", "[`launch.ts`](https://example.com/launch.ts)"],
		["only a link's definition, which shows nothing", "[launch]: https://example.com/launch"],
	];

	const KINDS: LiveArtifactKind[] = ["document", "slides"];

	it.each(
		KINDS.flatMap((kind) =>
			UNFITTING.map(([label, markdown]): [LiveArtifactKind, string, string] => [
				kind,
				label,
				markdown,
			]),
		),
	)("(%s) reads %s as content its schema holds, which reads back the same", (kind, _, markdown) => {
		const read = liveDocumentFromMarkdown(kind, markdown);

		read.check();
		expect(liveDocumentFromMarkdown(kind, markdownOfLiveDocument(read)).eq(read)).toBe(true);
	});

	it("keeps a task's box as the characters it is", () => {
		const items: string[] = [];
		parsed("- [ ] Book the room\n- [x] Send invites").descendants((node) => {
			if (node.type.name === "listItem") items.push(node.textContent);
		});

		expect(items).toEqual(["[ ] Book the room", "[x] Send invites"]);
	});

	it("keeps the address of a link around code, the mark of the two the schema can't hold together", () => {
		const linked: string[] = [];
		parsed("[`launch.ts`](https://example.com/launch.ts)").descendants((node) => {
			if (node.isText)
				linked.push(`${node.text}: ${node.marks.map((mark) => mark.attrs.href ?? mark.type.name)}`);
		});

		expect(linked).toEqual(["launch.ts: https://example.com/launch.ts"]);
	});
});
