import type { Node } from "@tiptap/pm/model";
import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import {
	DECK_SCHEMA,
	type DeckReading,
	deckFromHtml,
	type HtmlReader,
	htmlOfDeck,
	readDeckHtml,
} from "./deck-html.ts";
import { NODE_SUGGESTION } from "./live-document.ts";

/** Reads HTML as the API does, with linkedom. */
const reader: HtmlReader = new DOMParser();

const styled = (text: string, marks: object[] = []) => ({
	type: "text",
	text,
	marks: [
		...marks,
		{
			type: "textStyle",
			attrs: { color: "#ffffff", fontFamily: '"Source Serif", Georgia, serif', fontSize: 56 },
		},
	],
});

const SLIDE = {
	type: "slide",
	attrs: { layout: "title", background: "#0f172a" },
	content: [
		{
			type: "slideBody",
			content: [
				{
					type: "slideBox",
					attrs: {
						role: "title",
						verticalAlign: "bottom",
						frame: { x: 80, y: 100, width: 800, height: 176 },
						fill: "#1e3a8a",
						stroke: { color: "#93c5fd", width: 2 },
						padding: { top: 16, right: 24, bottom: 16, left: 24 },
					},
					content: [
						{
							type: "heading",
							attrs: { level: 1, textAlign: "center", lineHeight: 1.1 },
							content: [styled("Quarterly "), styled("review", [{ type: "bold" }])],
						},
					],
				},
				{
					type: "slideBox",
					attrs: {
						frame: { x: 700, y: 380, width: 160, height: 80 },
						fill: "#f59e0b",
						stroke: { color: "#78350f", width: 3 },
						path: "M 0 0 L 120 0 L 160 40 L 120 80 L 0 80 Z",
						verticalAlign: "middle",
						rotation: -15,
					},
					content: [
						{
							type: "paragraph",
							attrs: { textAlign: "center" },
							content: [{ type: "text", text: "Next" }],
						},
					],
				},
				{
					type: "slideBox",
					attrs: { frame: { x: 80, y: 320, width: 560, height: 120 } },
					content: [
						{
							type: "paragraph",
							content: [
								{ type: "text", text: " spaced  out\tand trailing  " },
								{ type: "hardBreak" },
								{ type: "text", text: " after a break" },
							],
						},
						{
							type: "paragraph",
							content: [
								{ type: "text", text: "Read " },
								{
									type: "text",
									text: "the report",
									marks: [{ type: "link", attrs: { href: "https://example.com/report" } }],
								},
								{
									type: "image",
									attrs: {
										src: "https://example.com/chart.png",
										alt: "Chart",
										link: "https://example.com/chart",
									},
								},
							],
						},
					],
				},
				{
					type: "slideBox",
					// A straight line, as a file's line imports: a box of no height.
					attrs: {
						frame: { x: 80, y: 460, width: 400, height: 0 },
						stroke: { color: "#64748b", width: 2 },
						path: "M 0 0 L 400 0",
					},
					content: [{ type: "paragraph" }],
				},
			],
		},
		{
			type: "speakerNotes",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Welcome everyone." }] }],
		},
	],
};

/** A slide written to the deck's HTML, as the cases below hold one. */
const KEPT_SLIDE = `<section data-slide data-layout="bullets"><div data-slide-body><div data-slide-box data-role="title"><h2>Kept</h2></div></div></section>`;

/** The deck's HTML of `KEPT_SLIDE`. */
const KEPT = [
	`<section data-slide data-layout="bullets">`,
	`  <div data-slide-body>`,
	`    <div data-slide-box data-role="title" style="left: 80px; top: 64px; width: 800px; height: 48px">`,
	`      <h2>Kept</h2>`,
	`    </div>`,
	`  </div>`,
	`</section>`,
].join("\n");

/** The deck's HTML of a slide of no layout holding a box for each of `boxes`, each where nothing places it, holding its blocks. */
const looseSlide = (...boxes: string[][]) =>
	[
		`<section data-slide>`,
		`  <div data-slide-body>`,
		...boxes.flatMap((blocks) => [
			`    <div data-slide-box style="left: 80px; top: 64px; width: 800px; height: 412px">`,
			...blocks.map((block) => `      ${block}`),
			`    </div>`,
		]),
		`  </div>`,
		`</section>`,
	].join("\n");

/** The deck's HTML of a slide of no layout holding one box of `style`, holding `blocks`. */
const boxSlide = (style: string, blocks: string[]) =>
	[
		`<section data-slide>`,
		`  <div data-slide-body>`,
		`    <div data-slide-box style="${style}">`,
		...blocks.map((block) => `      ${block}`),
		`    </div>`,
		`  </div>`,
		`</section>`,
	].join("\n");

const NOTHING: DeckReading = { outcome: "nothing" };
const TOO_DEEP: DeckReading = { outcome: "unreadable", reason: "nestedTooDeeply" };

/** Hostile and sloppy HTML, and the deck's HTML it reads back as, or what it reads as when it is no deck. */
const CASES: { name: string; html: string; writtenBack: string | DeckReading }[] = [
	{ name: "a doctype", html: `<!DOCTYPE html>${KEPT_SLIDE}`, writtenBack: KEPT },
	{
		name: "a whole page",
		html: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Deck</title><style>h2{color:red}</style></head><body>${KEPT_SLIDE}</body></html>`,
		writtenBack: KEPT,
	},
	{
		name: "what says nothing on a slide, beside it",
		html: `<style>p{}</style><script>alert(1)</script><title>T</title><meta name="x"><link rel="stylesheet" href="x.css">${KEPT_SLIDE}`,
		writtenBack: KEPT,
	},
	{
		name: "blocks beside a slide, in an element around them",
		html: `<main><div><h1>Before</h1>${KEPT_SLIDE}<p>After</p></div></main>`,
		writtenBack: [looseSlide(["<h1>Before</h1>"]), KEPT, looseSlide(["<p>After</p>"])].join("\n\n"),
	},
	{
		name: "a block and a box after a slide's notes",
		html: `<section data-slide><div data-slide-body><div data-slide-box><p>Box</p></div></div><aside data-speaker-notes><p>Note</p></aside><p>Late</p><div data-slide-box><p>Late box</p></div></section>`,
		writtenBack: looseSlide(["<p>Box</p>"], ["<p>Late</p>"], ["<p>Late box</p>"]).replace(
			"  </div>\n</section>",
			"  </div>\n  <aside data-speaker-notes>\n    <p>Note</p>\n  </aside>\n</section>",
		),
	},
	{
		name: "blocks either side of a slide's body, and its notes twice",
		html: `<section data-slide><p>First</p><div data-slide-body><div data-slide-box><p>Box</p></div></div><p>Middle</p><aside data-speaker-notes><p>One</p></aside><aside data-speaker-notes><p>Two</p></aside></section>`,
		writtenBack: looseSlide(["<p>First</p>"], ["<p>Box</p>"], ["<p>Middle</p>"]).replace(
			"  </div>\n</section>",
			"  </div>\n  <aside data-speaker-notes>\n    <p>One</p>\n    <p>Two</p>\n  </aside>\n</section>",
		),
	},
	{
		name: "a slide inside a slide",
		html: `<section data-slide><p>A</p><section data-slide><p>B</p></section><p>C</p></section>`,
		writtenBack: [looseSlide(["<p>A</p>", "<p>C</p>"]), looseSlide(["<p>B</p>"])].join("\n\n"),
	},
	{
		name: "suggestions written as HTML",
		html: `<section data-slide><div data-slide-box><p><ins data-id='"u1:person:Dave"'>x</ins> <ins data-id="u1:person:Dave">y</ins></p></div></section>`,
		writtenBack: looseSlide(["<p>x y</p>"]),
	},
	{
		name: "a suggestion written as a node's attribute",
		html: `<section data-slide><div data-slide-box><p suggestion="{">x</p><p suggestion='[{"type":"insertion","attrs":{"id":"1:person:Dave"}}]'>y</p></div></section>`,
		writtenBack: looseSlide(["<p>x</p>", "<p>y</p>"]),
	},
	{
		name: "a stray end of the page's body",
		html: `${KEPT_SLIDE}</body><p>After the body</p>`,
		writtenBack: [KEPT, looseSlide(["<p>After the body</p>"])].join("\n\n"),
	},
	{ name: "words alone", html: "Hello there", writtenBack: looseSlide(["<p>Hello there</p>"]) },
	{
		name: "a border of a style the deck has no word for, and a background that is no colour",
		html: `<section data-slide><div data-slide-box style="left: 0px; top: 0px; width: 100px; height: 50px; border: 2px wavy red; background: fixed"><p>x</p></div></section>`,
		writtenBack: boxSlide(
			"left: 0px; top: 0px; width: 100px; height: 50px; border: 2px solid red",
			["<p>x</p>"],
		),
	},
	{
		name: "text styled with images, beside text styled with fonts of any script",
		html: `<section data-slide><div data-slide-box style="left: 0px; top: 0px; width: 100px; height: 50px"><p><span style="color: url(https://evil.example/d.png); font-family: url(x), serif">x</span> <span style="color: Teal; font-family: 'Noto Sans JP', &quot;游ゴシック&quot;, sans-serif">y</span></p></div></section>`,
		writtenBack: boxSlide("left: 0px; top: 0px; width: 100px; height: 50px", [
			`<p>x <span style="color: Teal; font-family: 'Noto Sans JP', &quot;游ゴシック&quot;, sans-serif">y</span></p>`,
		]),
	},
	{
		name: "a drawing of two paths each moving from where it is, with a description and shapes it doesn't draw",
		html: `<section data-slide><div data-slide-box style="left: 0px; top: 0px; width: 100px; height: 100px"><svg viewBox="0 0 100 100"><desc>An arrow</desc><defs><rect width="5" height="5"/></defs><path d="m 10 10 l 20 0"/><path d="m 50 50 l 20 0"/></svg><p>x</p></div></section>`,
		writtenBack: boxSlide("left: 0px; top: 0px; width: 100px; height: 100px", [
			`<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M 10 10 l 20 0 M 50 50 l 20 0" fill="black"/></svg>`,
			"<p>x</p>",
		]),
	},
	{
		name: "numbers past what any slide shows",
		html: `<section data-slide><div data-slide-box style="left: 99999px; top: 0px; width: 10px; height: 10px; padding: 9999px 2px; transform: rotate(7210deg); border: 99999px solid red"><p style="line-height: 5000"><span style="font-size: 999999px">x</span><span style="font-size: 0.25px">y</span></p></div><div data-slide-box style="left: 0px; top: 0px; width: 10px; height: 10px; transform: rotate(1e-7deg)"><svg viewBox="0 0 10 10"><path d="M 0 0 L 99999 0 A 5 5 7210 0 1 1 1"/></svg><p>z</p></div></section>`,
		writtenBack: [
			`<section data-slide>`,
			`  <div data-slide-body>`,
			`    <div data-slide-box style="left: 3840px; top: 0px; width: 0px; height: 10px; border: 1584px solid red; padding: 3840px 2px; transform: rotate(10deg)">`,
			`      <p style="line-height: 100"><span style="font-size: 4000px">x</span><span style="font-size: 1px">y</span></p>`,
			`    </div>`,
			`    <div data-slide-box style="left: 0px; top: 0px; width: 10px; height: 10px; transform: rotate(1e-7deg)">`,
			`      <svg viewBox="0 0 10 10" preserveAspectRatio="none"><path d="M 0 0 L 3840 0 A 5 5 10 0 1 1 1" fill="black"/></svg>`,
			`      <p>z</p>`,
			`    </div>`,
			`  </div>`,
			`</section>`,
		].join("\n"),
	},
	{
		name: "elements nested as deep as may be read",
		html: `<section data-slide><div data-slide-body><div data-slide-box>${"<div>".repeat(97)}x</div></div></section>`,
		writtenBack: looseSlide(["<p>x</p>"]),
	},
	{ name: "nothing but blank space", html: " \n\t ", writtenBack: NOTHING },
	{ name: "a comment", html: "<!-- nothing -->", writtenBack: NOTHING },
	{ name: "a doctype alone", html: "<!DOCTYPE html>", writtenBack: NOTHING },
	{
		name: "a page with nothing in its body",
		html: "<html><head><title>Deck</title><style>p{}</style></head><body></body></html>",
		writtenBack: NOTHING,
	},
	{ name: "elements holding nothing", html: "<div></div><br>", writtenBack: NOTHING },
	{
		name: "elements nested one deeper than may be read",
		html: `<section data-slide><div data-slide-body><div data-slide-box>${"<div>".repeat(98)}x</div></div></section>`,
		writtenBack: TOO_DEEP,
	},
	{ name: "20,000 nested elements", html: `${"<div>".repeat(20_000)}x`, writtenBack: TOO_DEEP },
	{
		name: "9,000 nested quotes",
		html: `<section data-slide><div data-slide-box>${"<blockquote>".repeat(9_000)}x</div></section>`,
		writtenBack: TOO_DEEP,
	},
];

/** The suggestions `deck`'s nodes say in their attribute, which no HTML may give them. */
function suggestionsSaid(deck: Node): unknown[] {
	const said: unknown[] = [];
	deck.descendants((node) => {
		if (node.attrs[NODE_SUGGESTION] != null) said.push(node.attrs[NODE_SUGGESTION]);
	});
	return said;
}

describe("a deck's HTML", () => {
	it("reads back as the deck it was written from, spaces, links and all", () => {
		const deck = DECK_SCHEMA.nodeFromJSON({ type: "doc", content: [SLIDE] });
		const html = htmlOfDeck(deck);
		expect(deckFromHtml(html, reader).toJSON()).toEqual(deck.toJSON());
	});

	it.each(CASES)("reads $name as what it says, losing none of it", ({ html, writtenBack }) => {
		const reading = readDeckHtml(html, reader);
		if (reading.outcome !== "deck") {
			expect(reading).toEqual(writtenBack);
			return;
		}
		// What is read is always a deck its schema holds, with no suggestion in it.
		reading.deck.check();
		expect(suggestionsSaid(reading.deck)).toEqual([]);
		expect(htmlOfDeck(reading.deck)).toEqual(writtenBack);
	});
});
