import type { ArtifactImageType } from "@sugabots/contracts";
import {
	type ArtifactImageIds,
	artifactImageAddress,
	artifactImageIds,
} from "@sugabots/contracts/http";
import type { Frame } from "@sugabots/contracts/slide-geometry";
import type { Node } from "@tiptap/pm/model";
import { Effect } from "effect";
import { imageSize } from "image-size";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { pdfFileOf } from "./pdf.ts";
import { type PowerPointImage, powerPointFileOf } from "./powerpoint.ts";
import { boxHtml, deckOf, slideHtml } from "./slides.test-support.ts";

/*
 * A deck's PowerPoint file, read back from its XML, as PowerPoint reads it:
 * which layout each slide is on, which shape is its title, where each shape
 * is and how it is drawn, and the runs, lists, tables, pictures and notes
 * PowerPoint makes of what each holds.
 */

const ARTIFACT = {
	podId: "0199a3a0-0000-7000-8000-000000000001",
	id: "0199a3a0-0000-7000-8000-000000000002",
	title: "Launch review",
};

/**
 * Images of the kinds a deck keeps: a one-pixel PNG, which PowerPoint draws, a
 * one-pixel WebP, which it may not, and a phone's photo, a JPEG stored 4
 * pixels across and 2 down whose EXIF says to turn it a quarter clockwise, so
 * it shows 2 across and 4 down.
 */
const IMAGES: Partial<Record<ArtifactImageType, Buffer>> = {
	"image/png": Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
	"image/webp": Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
	"image/jpeg": Buffer.from(
		"/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAQAAAADoAQAAQAAAAIAAAAAAAAA/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAEQgAAgAEAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABUBAQEAAAAAAAAAAAAAAAAAAAQG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgAKt//Z",
		"base64",
	),
};

/** The address of an image kept for `artifactId`, by the id of the kind it is. */
function keptImage(type: ArtifactImageType, artifactId = ARTIFACT.id): string {
	const imageId = Buffer.from(type).toString("hex").padEnd(64, "0").slice(0, 64);
	const ids = artifactImageIds({ podId: ARTIFACT.podId, artifactId, imageId });
	if (!ids) throw new Error("fixture");
	return artifactImageAddress(ids);
}

/** The images the artifact keeps, by id. */
const keptImages = new Map(
	(Object.entries(IMAGES) as [ArtifactImageType, Buffer][]).map(([type, bytes]) => [
		keptImage(type).split("/").at(-1),
		{ contentType: type, bytes } satisfies PowerPointImage,
	]),
);

/** An image's HTML, as a deck keeps one. */
const imageHtml = (words: string, address: string) =>
	`<img alt="${words}" data-address="${address}">`;

/** A slide of bullets: its title, and the blocks of the box under it, each where the layout puts it. */
const bulletsSlide = (title: string, body: string) =>
	slideHtml([boxHtml(`<h2>${title}</h2>`, { role: "title" }), boxHtml(body, { role: "body" })], {
		layout: "bullets",
	});

/** A list's HTML, its items' words each a paragraph. */
const listHtml = (tag: "ul" | "ol", items: readonly string[]) =>
	`<${tag}>${items.map((item) => `<li><p>${item}</p></li>`).join("")}</${tag}>`;

const TABLE =
	"<table><tr><th><p>Milestone</p></th><th><p>Owner</p></th></tr><tr><td><p>Beta</p></td><td><p>Priya</p></td></tr><tr><td><p>Launch</p></td><td><p>Marco</p></td></tr></table>";

/** A deck with a slide of each layout, as a bot writes one. */
const DECK = [
	slideHtml(
		[
			boxHtml("<h1>Launch review</h1>", { role: "title", verticalAlign: "bottom" }),
			boxHtml("<p>Q3, for the whole team</p>", { role: "subtitle" }),
		],
		{
			layout: "title",
			notes: "<p>Welcome everyone.</p><p>Say the <strong>new</strong> pod's name.</p>",
		},
	),
	bulletsSlide(
		"Goals",
		[
			"<ul><li><p>Ship <em>live</em> slides</p><ul><li><p>with suggestions</p></li><li><p>and notes</p></li></ul></li>",
			"<li><p>Keep <strong>everything</strong>, <s>nothing</s> lost: <code>markdown</code>, x<sup>2</sup>, H<sub>2</sub>O, <u>this</u> and <mark>that</mark></p></li>",
			'<li><p>Read <a href="https://example.com/plan">the plan</a>, not <a href="javascript:alert(1)">this</a></p></li></ul>',
			'<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>',
		].join(""),
	),
	slideHtml(
		[
			boxHtml("<h2>People and bots</h2>", { role: "title" }),
			boxHtml(`<h3>People</h3>${listHtml("ul", ["Type in the page"])}`, { role: "leftColumn" }),
			boxHtml(`<h3>Bots</h3>${listHtml("ol", ["Suggest changes"])}`, { role: "rightColumn" }),
		],
		{ layout: "columns" },
	),
	slideHtml(
		[
			boxHtml("<h2>The chart</h2>", { role: "title" }),
			boxHtml("<p>Sales went up.</p>", { role: "text" }),
			boxHtml(`<p>${imageHtml("The launch chart", keptImage("image/png"))}</p>`, {
				role: "image",
				verticalAlign: "middle",
			}),
		],
		{ layout: "image" },
	),
	slideHtml(
		[
			boxHtml("<p>Part 2</p>", { role: "label" }),
			boxHtml("<h2>Where we are</h2>", { role: "title" }),
		],
		{ layout: "section" },
	),
	slideHtml(
		[
			boxHtml("<blockquote><p>Nothing a person writes is lost.</p></blockquote>", {
				role: "quote",
			}),
			boxHtml("<p>The team</p>", { role: "attribution" }),
		],
		{ layout: "quote" },
	),
	slideHtml([boxHtml("<h2>Owners</h2>", { role: "title" }), boxHtml(TABLE, { role: "table" })], {
		layout: "table",
	}),
].join("\n");

/** The PowerPoint file of `deck`, and the images it asked for. */
async function powerPointOfDeck(deck: Node) {
	const asked: ArtifactImageIds[] = [];
	const file = await Effect.runPromise(
		powerPointFileOf(ARTIFACT, deck, (image) => {
			asked.push(image);
			return Effect.succeed(keptImages.get(image.imageId));
		}),
	);
	return { file: await JSZip.loadAsync(file), asked };
}

/** The PowerPoint file of the deck `html` reads as, and the images it asked for. */
const powerPointFile = (html: string) => powerPointOfDeck(deckOf(html));

type File = JSZip;

const partOf = async (file: File, part: string) => (await file.file(part)?.async("string")) ?? "";

const slideXml = (file: File, number: number) => partOf(file, `ppt/slides/slide${number}.xml`);

/** The parts of `file` whose paths match `path`, sorted by their number. */
const partsMatching = (file: File, path: RegExp) =>
	Object.keys(file.files)
		.filter((name) => path.test(name))
		.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));

/** Each slide's XML, in order. */
const slidesOf = (file: File) =>
	Promise.all(
		partsMatching(file, /^ppt\/slides\/slide\d+\.xml$/).map((part) => partOf(file, part)),
	);

/** The layout part the slide numbered `number` is on. */
async function layoutPartOf(file: File, number: number): Promise<string> {
	const relationships = await partOf(file, `ppt/slides/_rels/slide${number}.xml.rels`);
	const target = /Target="\.\.\/(slideLayouts\/slideLayout\d+\.xml)"/.exec(relationships)?.[1];
	return `ppt/${target}`;
}

const nameOf = (xml: string) => /<p:cSld name="([^"]*)"/.exec(xml)?.[1];

const shapesOf = (xml: string) => xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];

const paragraphsOf = (xml: string) => xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [];

/** What a paragraph of `xml` says, its runs' text joined. */
const textOf = (xml: string) =>
	[...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
		.map(([, text]) => text)
		.join("")
		.replaceAll("&apos;", "'");

/** The placeholder a shape is, by its type and number. */
function placeholderOf(shape: string) {
	const placeholder = /<p:ph\b[^>]*>/.exec(shape)?.[0] ?? "";
	return {
		type: /\btype="(\w+)"/.exec(placeholder)?.[1],
		index: /\bidx="(\d+)"/.exec(placeholder)?.[1],
	};
}

/** Each placeholder of a slide that holds words: its type, and its paragraphs' text. */
const filledPlaceholders = (xml: string) =>
	shapesOf(xml)
		.filter((shape) => shape.includes("<p:ph") && textOf(shape) !== "")
		.map((shape) => [placeholderOf(shape).type, paragraphsOf(shape).map(textOf)]);

/** Each shape of a slide that holds words and is no placeholder: its paragraphs' text. */
const filledShapes = (xml: string) =>
	shapesOf(xml)
		.filter((shape) => !shape.includes("<p:ph") && textOf(shape) !== "")
		.map((shape) => paragraphsOf(shape).map(textOf));

/** The run of `xml` holding `text`, with its properties. */
const runHolding = (xml: string, text: string) =>
	(xml.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? []).find((run) => run.includes(`<a:t>${text}</a:t>`)) ??
	"";

/** The paragraph of `xml` whose text is `text`. */
const paragraphSaying = (xml: string, text: string) =>
	paragraphsOf(xml).find((paragraph) => textOf(paragraph) === text) ?? "";

/** The sizes, in hundredths of a point, of the runs of `xml`. */
const runSizesOf = (xml: string) => [
	...new Set([...xml.matchAll(/<a:rPr [^>]*\bsz="(\d+)"/g)].map(([, size]) => Number(size))),
];

/** The shape of `xml` holding a run of `text`. */
const shapeHolding = (xml: string, text: string) =>
	(xml.match(/<p:sp>[\s\S]*?<\/p:sp>|<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? []).find(
		(shape) => shape.includes(`<a:t>${text}</a:t>`),
	) ?? "";

/** Where a shape is on its slide, in points. */
function boxOf(shape: string) {
	const [x = 0, y = 0, w = 0, h = 0] = (
		/<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)?.slice(1) ??
		[]
	).map((emus) => Number(emus) / 12_700);
	return { x, y, w, h };
}

/**
 * The step the deck's PDF draws its first slide's text at: the size of its
 * last stretch of text, which is text of `fullSize` units at full size, over
 * that full size, on a PDF page 720 points wide, which is 12 to the unit.
 */
async function pdfStepOf(html: string, fullSize: number): Promise<number> {
	const file = await Effect.runPromise(pdfFileOf(ARTIFACT, deckOf(html), () => Effect.undefined));
	const page = await (await getDocumentProxy(file.slice())).getPage(1);
	const last = (await page.getTextContent()).items
		.flatMap((item) => ("str" in item ? [item] : []))
		.at(-1);
	return Math.hypot(last?.transform[0] ?? 0, last?.transform[1] ?? 0) / (fullSize * 12);
}

/** The owner's own deck's first slide: a paragraph and four bullets with bold lead-ins in one column, and an empty table in the other. */
const TWO_COLUMNS = slideHtml(
	[
		boxHtml("<h2>One page for people and bots</h2>", { role: "title" }),
		boxHtml(
			`<p>Shared documents let a team and its bots write one page together, without anyone losing work.</p>${listHtml(
				"ul",
				[
					"<strong>What it is:</strong> one page that people and bots edit side by side.",
					"<strong>Who it is for:</strong> teams that already use bots to draft, review and tidy documents.",
					"<strong>What changes:</strong> edits from bots arrive as suggestions, so people stay in control.",
					"<strong>Where we start:</strong> our own workspaces, then teams who asked to join.",
				],
			)}`,
			{ role: "leftColumn" },
		),
		boxHtml(
			`<table>${"<tr><td><p></p></td><td><p></p></td><td><p></p></td></tr>".repeat(3)}</table>`,
			{ role: "rightColumn" },
		),
	],
	{ layout: "columns" },
);

/** The one layout's name, as PowerPoint names a layout holding a title alone. */
const LAYOUT_NAME = "Title Only";

describe("a deck's PowerPoint file", () => {
	it("holds a slide for each of the deck's, in order, each on the one layout, which holds a title alone", async () => {
		const { file } = await powerPointFile(DECK);

		const slides = partsMatching(file, /^ppt\/slides\/slide\d+\.xml$/);
		const layoutsOfSlides = await Promise.all(
			slides.map(async (_slide, index) =>
				nameOf(await partOf(file, await layoutPartOf(file, index + 1))),
			),
		);
		expect(layoutsOfSlides).toEqual(Array(7).fill(LAYOUT_NAME));
		const layouts = partsMatching(file, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/);
		expect(layouts).toHaveLength(1);
		const layout = await partOf(file, layouts[0] ?? "");
		expect(shapesOf(layout).map((shape) => placeholderOf(shape).type)).toEqual(["title"]);
		const master = await partOf(file, "ppt/slideMasters/slideMaster1.xml");
		expect(master.match(/<p:sldLayoutId /g)).toHaveLength(1);
	});

	it("makes each slide's title box, or else its quote, its title placeholder, and every other box a shape of its own", async () => {
		const { file } = await powerPointFile(DECK);

		const slides = await slidesOf(file);
		expect(slides.map(filledPlaceholders)).toEqual([
			[["title", ["Launch review"]]],
			[["title", ["Goals"]]],
			[["title", ["People and bots"]]],
			[["title", ["The chart"]]],
			[["title", ["Where we are"]]],
			[["title", ["Nothing a person writes is lost."]]],
			[["title", ["Owners"]]],
		]);
		expect(slides.map(filledShapes)).toEqual([
			[["Q3, for the whole team"]],
			[
				[
					"Ship live slides",
					"with suggestions",
					"and notes",
					"Keep everything, nothing lost: markdown, x2, H2O, this and that",
					"Read the plan, not this",
					"Third",
					"Fourth",
				],
			],
			[
				["People", "Type in the page"],
				["Bots", "Suggest changes"],
			],
			[["Sales went up."]],
			[["Part 2"]],
			[["The team"]],
			[],
		]);
		for (const slide of slides) {
			expect(shapesOf(slide).filter((shape) => shape.includes("<p:ph"))).toHaveLength(1);
		}
	});

	it("puts a section break's accent bar over its label, marked as decoration", async () => {
		const { file } = await powerPointFile(DECK);

		const slides = await slidesOf(file);
		const bar = shapesOf(slides[4] ?? "").find((shape) => shape.includes('name="Accent bar"'));
		expect(bar).toContain('<adec:decorative xmlns:adec="');
		expect(bar).toContain('<a:srgbClr val="2563EB"/>');
		// A unit's gap and the bar, 0.3 units tall, over the label at the top of its frame.
		expect(boxOf(bar ?? "").y).toBeCloseTo(360 - 16 - 4.8);
		expect(slides.filter((slide) => slide.includes('name="Accent bar"'))).toHaveLength(1);
	});

	it("keeps each run's bold, italics and other marks, and a link as a real hyperlink where a link may go", async () => {
		const { file } = await powerPointFile(DECK);

		const xml = await slideXml(file, 2);
		expect(runHolding(xml, "live")).toMatch(/<a:rPr [^>]*\bi="1"/);
		expect(runHolding(xml, "everything")).toMatch(/<a:rPr [^>]*\bb="1"/);
		expect(runHolding(xml, "nothing")).toMatch(/<a:rPr [^>]*\bstrike="sngStrike"/);
		expect(runHolding(xml, "this")).toMatch(/<a:rPr [^>]*\bu="sng"/);
		expect(runHolding(xml, "2")).toMatch(/<a:rPr [^>]*\bbaseline="30000"/);
		expect(runHolding(xml, "markdown")).toContain('<a:latin typeface="Courier New"');
		expect(runHolding(xml, "that")).toContain(
			'<a:highlight><a:srgbClr val="FFFF00"/></a:highlight>',
		);
		const link = /<a:hlinkClick r:id="(rId\d+)"/.exec(runHolding(xml, "the plan"))?.[1];
		const relationships = await partOf(file, "ppt/slides/_rels/slide2.xml.rels");
		expect(relationships).toContain(
			`<Relationship Id="${link}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/plan" TargetMode="External"/>`,
		);
		expect(xml.match(/<a:hlinkClick /g)).toHaveLength(1);
		expect(relationships).not.toContain("javascript");
	});

	it("links only to absolute addresses, written as a reader can follow them, wherever the file is saved", async () => {
		const { file } = await powerPointFile(
			bulletsSlide(
				"Links",
				'<p><a href="/pods/abc/artifacts/def">in the app</a> <a href="plan.pdf">beside it</a> <a href="#top">here</a> <a href="https://example.com/café?q=日本">café</a></p>',
			),
		);

		const relationships = await partOf(file, "ppt/slides/_rels/slide1.xml.rels");
		expect(
			[...relationships.matchAll(/Target="([^"]*)" TargetMode="External"/g)].map(
				([, target]) => target,
			),
		).toEqual(["https://example.com/caf%C3%A9?q=%E6%97%A5%E6%9C%AC"]);
		expect((await slideXml(file, 1)).match(/<a:hlinkClick /g)).toHaveLength(1);
	});

	it("writes lists as PowerPoint's own, nested at their depth and numbered from where they start", async () => {
		const { file } = await powerPointFile(DECK);

		const xml = await slideXml(file, 2);
		expect(paragraphSaying(xml, "Ship live slides")).toMatch(
			/^<a:p><a:pPr algn="l" marL="\d+" indent="-\d+">[\s\S]*<a:buChar char="&#x2022;"\/>/,
		);
		expect(paragraphSaying(xml, "with suggestions")).toMatch(
			/^<a:p><a:pPr algn="l" lvl="1" [^>]*>[\s\S]*<a:buChar char="&#x25E6;"\/>/,
		);
		expect(paragraphSaying(xml, "Third")).toContain(
			'<a:buAutoNum type="arabicPeriod" startAt="3"/>',
		);
		expect(paragraphSaying(xml, "Fourth")).toContain(
			'<a:buAutoNum type="arabicPeriod" startAt="3"/>',
		);
	});

	it("holds a table as PowerPoint's own, its header row bold and grey on a tint", async () => {
		const { file } = await powerPointFile(DECK);

		const table = /<a:tbl>[\s\S]*<\/a:tbl>/.exec(await slideXml(file, 7))?.[0] ?? "";
		const rows = table.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? [];
		expect(rows.map((row) => (row.match(/<a:tc>[\s\S]*?<\/a:tc>/g) ?? []).map(textOf))).toEqual([
			["Milestone", "Owner"],
			["Beta", "Priya"],
			["Launch", "Marco"],
		]);
		expect(runHolding(rows[0] ?? "", "Milestone")).toMatch(
			/<a:rPr [^>]*\bb="1"[^>]*><a:solidFill><a:srgbClr val="52525B"\/>/,
		);
		expect(rows[0]).toMatch(/<a:solidFill><a:srgbClr val="F4F4F5"\/><\/a:solidFill>\s*<\/a:tcPr>/);
		expect(rows[1]).not.toContain("F4F4F5");
	});

	it("holds the deck's own image with its words, and gives any other image, or one PowerPoint may not draw, as its words on a line of their own, as the PDF does", async () => {
		const { file, asked } = await powerPointFile(
			slideHtml(
				[
					boxHtml("<h2>Charts</h2>", { role: "title" }),
					boxHtml(
						`<p>${imageHtml("Theirs", keptImage("image/png", "0199a3a0-0000-7000-8000-000000000009"))} and ${imageHtml("A WebP chart", keptImage("image/webp"))}</p>`,
						{ role: "text" },
					),
					boxHtml(`<p>${imageHtml("The launch chart", keptImage("image/png"))}</p>`, {
						role: "image",
						verticalAlign: "middle",
					}),
				],
				{ layout: "image" },
			),
		);

		expect(asked.map(({ artifactId }) => artifactId)).toEqual([ARTIFACT.id, ARTIFACT.id]);
		const media = partsMatching(file, /^ppt\/media\//);
		expect(media).toHaveLength(1);
		expect(await file.file(media[0] ?? "")?.async("nodebuffer")).toEqual(IMAGES["image/png"]);
		const xml = await slideXml(file, 1);
		expect(xml.match(/<p:pic>/g)).toHaveLength(1);
		expect(xml).toMatch(/<p:cNvPr id="\d+" name="[^"]*" descr="The launch chart">/);
		expect(filledPlaceholders(xml)).toEqual([["title", ["Charts"]]]);
		expect(filledShapes(xml)).toEqual([["Theirs"], [" and "], ["A WebP chart"]]);
	});

	it("fills an image box with the picture it holds alone, whole on a template's slide and cropped about its middle on a blank one, turned upright as its EXIF says", async () => {
		const pictureBox = (type: ArtifactImageType, frame?: Frame) =>
			boxHtml(`<p>${imageHtml("A photo", keptImage(type))}</p>`, { role: "image", frame });
		const { file } = await powerPointFile(
			[
				slideHtml([boxHtml("<h2>Chart</h2>", { role: "title" }), pictureBox("image/png")], {
					layout: "image",
				}),
				slideHtml([pictureBox("image/jpeg", { x: 0, y: 0, width: 960, height: 540 })]),
			].join(""),
		);

		const pictureOf = (xml: string) => /<p:pic>[\s\S]*?<\/p:pic>/.exec(xml)?.[0] ?? "";
		const whole = pictureOf(await slideXml(file, 1));
		const cropped = pictureOf(await slideXml(file, 2));
		// The pixel drawn as large as fits the image layout's box, 372 across and 412 down, in its middle.
		expect(boxOf(whole)).toEqual({ x: 508, y: 84, w: 372, h: 372 });
		expect(whole).not.toContain("<a:srcRect");
		// Shown 2 across and 4 down, the photo is cut to the slide's height about its middle,
		// which is across its pixels as stored, its box as stored turned a quarter onto the slide.
		expect(cropped).toContain('<a:srcRect l="35938" r="35938" t="0" b="0"/>');
		expect(cropped).toContain('<a:xfrm rot="5400000">');
		expect(boxOf(cropped)).toEqual({ x: 210, y: -210, w: 540, h: 960 });
		const media = partsMatching(file, /^ppt\/media\/.*\.jpe?g$/);
		const embedded = await file.file(media[0] ?? "")?.async("nodebuffer");
		expect(imageSize(embedded ?? Buffer.alloc(0)).orientation).toBe(1);
	});

	it("puts each slide's speaker notes in its notes, a paragraph each, keeping their bold", async () => {
		const { file } = await powerPointFile(DECK);

		const notes = await partOf(file, "ppt/notesSlides/notesSlide1.xml");
		const body =
			shapesOf(notes).find((shape) => shape.includes('<p:ph type="body" idx="1"/>')) ?? "";
		expect(paragraphsOf(body).map(textOf)).toEqual([
			"Welcome everyone.",
			"Say the new pod's name.",
		]);
		expect(runHolding(body, "new")).toContain('b="1"');
		expect(textOf(await partOf(file, "ppt/notesSlides/notesSlide2.xml"))).not.toContain("Welcome");
	});

	it("stacks what PowerPoint's text can't hold, as a table, apart from the text around it in its box", async () => {
		const { file } = await powerPointFile(
			slideHtml(
				[
					boxHtml("<h1>Launch review</h1>", { role: "title" }),
					boxHtml(
						"<p>Q3</p><table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table><blockquote><p>Ship it.</p></blockquote><pre><code>bun run dev</code></pre>",
						{ role: "subtitle" },
					),
				],
				{ layout: "title" },
			),
		);

		const xml = await slideXml(file, 1);
		expect(filledPlaceholders(xml)).toEqual([["title", ["Launch review"]]]);
		expect(xml).toContain("<a:tbl>");
		expect(filledShapes(xml)).toEqual([["Q3"], ["Ship it.", "bun run dev"]]);
		expect(runHolding(xml, "Ship it.")).toMatch(/<a:rPr [^>]*\bi="1"/);
		expect(runHolding(xml, "bun run dev")).toContain('<a:latin typeface="Courier New"');
	});

	it("states each paragraph's alignment, as the app draws it or as it sets its own, leaving nothing to a centred default", async () => {
		const { file } = await powerPointFile(DECK);
		const aligned = await powerPointFile(
			bulletsSlide(
				"Aligned",
				'<p style="text-align: right">Right</p><p style="text-align: justify">Even</p>',
			),
		);

		for (const xml of await slidesOf(file)) {
			for (const paragraph of paragraphsOf(xml)) expect(paragraph).toMatch(/^<a:p><a:pPr algn="l"/);
		}
		const xml = await slideXml(aligned.file, 1);
		expect(paragraphSaying(xml, "Right")).toMatch(/^<a:p><a:pPr algn="r"/);
		expect(paragraphSaying(xml, "Even")).toMatch(/^<a:p><a:pPr algn="just"/);
	});

	it("sets a slide's text at full size where it fits, each box at its frame", async () => {
		const { file } = await powerPointFile(
			bulletsSlide("Goals", listHtml("ul", ["Ship it", "Keep it"])),
		);

		const xml = await slideXml(file, 1);
		expect(runSizesOf(shapeHolding(xml, "Goals"))).toEqual([4000]);
		expect(runSizesOf(shapeHolding(xml, "Ship it"))).toEqual([2400]);
		// The layout's text under its title: from 9 units down, to the margin of 4 units at the slide's foot.
		expect(boxOf(shapeHolding(xml, "Ship it"))).toEqual({ x: 80, y: 144, w: 800, h: 332 });
	});

	it("draws each box as it is drawn, on the slide's background: filled, outlined within its frame, turned, a shape's path as a freeform, and text in its own colour, size and font", async () => {
		const { file } = await powerPointFile(
			slideHtml(
				[
					boxHtml("<h2>Goals</h2>", {
						role: "title",
						frame: { x: 80, y: 64, width: 400, height: 60 },
						style:
							"background: rgb(30 58 138 / 50%); border: 2px solid #93c5fd; padding: 4px 8px 12px 16px",
					}),
					boxHtml(
						'<p><span style="color: #fbbf24; font-family: &quot;Elephant Pro&quot;, serif; font-size: 40px">Next</span></p>',
						{
							frame: { x: 600, y: 200, width: 200, height: 100 },
							style: "transform: rotate(-15deg); background: #f59e0b",
							path: "M 0 0 L 160 0 L 200 50 L 160 100 L 0 100 Z",
							verticalAlign: "middle",
						},
					),
				],
				{ layout: "bullets", background: "#0f172a" },
			),
		);

		const xml = await slideXml(file, 1);
		expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F172A"/>');
		const title = shapeHolding(xml, "Goals");
		expect(placeholderOf(title).type).toBe("title");
		expect(boxOf(title)).toEqual({ x: 81, y: 65, w: 398, h: 58 });
		expect(title).toContain('<a:solidFill><a:srgbClr val="1E3A8A"><a:alpha val="50000"/>');
		expect(title).toContain('<a:ln w="25400"><a:solidFill><a:srgbClr val="93C5FD"/>');
		// Its padding and outline, less the half of the outline the shape's edge is inset by: 17, 5, 9 and 13 points.
		expect(title).toMatch(/<a:bodyPr [^>]*lIns="215900" tIns="63500" rIns="114300" bIns="165100"/);
		const shape = shapeHolding(xml, "Next");
		expect(shape).toContain('<a:xfrm rot="20700000">');
		expect(shape).toMatch(/<a:custGeom>[\s\S]*<a:moveTo><a:pt x="0" y="0" \/><\/a:moveTo>/);
		expect(shape).toContain('<a:lnTo><a:pt x="2540000" y="635000" /></a:lnTo>');
		expect(shape).toContain('<a:solidFill><a:srgbClr val="F59E0B"/>');
		expect(shape).toMatch(/<a:bodyPr [^>]*anchor="ctr"/);
		const run = runHolding(shape, "Next");
		expect(run).toMatch(/<a:rPr [^>]*\bsz="4000"/);
		expect(run).toContain('<a:srgbClr val="FBBF24"/>');
		expect(run).toContain('<a:latin typeface="Elephant Pro"');
	});

	it("sets the text of a slide too long for full size at the step the PDF draws it at", async () => {
		const step = await pdfStepOf(TWO_COLUMNS, 1.25);
		const { file } = await powerPointFile(TWO_COLUMNS);

		expect(step).toBeLessThan(1);
		const xml = await slideXml(file, 1);
		expect(runSizesOf(shapeHolding(xml, "One page for people and bots"))).toEqual([
			Math.round(4000 * step),
		]);
		expect(runSizesOf(shapeHolding(xml, "What it is:"))).toEqual([Math.round(2000 * step)]);
		expect(xml).toContain(`marL="${Math.round(0.8 * 20 * step * 12_700)}"`);
	});

	it("sets the text of a slide that fits only at the smallest step at that step", async () => {
		const html = bulletsSlide(
			"Points",
			listHtml(
				"ul",
				Array.from({ length: 10 }, (_, index) => `Point ${index + 1}`),
			),
		);
		const step = await pdfStepOf(html, 1.5);
		const { file } = await powerPointFile(html);

		expect(step).toBeCloseTo(0.7);
		const xml = await slideXml(file, 1);
		expect(runSizesOf(shapeHolding(xml, "Points"))).toEqual([Math.round(4000 * step)]);
		expect(runSizesOf(shapeHolding(xml, "Point 10"))).toEqual([Math.round(2400 * step)]);
	});

	it("sets a table's text and padding, and what is stacked in boxes of its own, at the slide's step", async () => {
		const lines = Array.from({ length: 6 }, (_, index) => `<p>Line ${index + 1}</p>`).join("");
		const html = slideHtml(
			[
				boxHtml("<h1>Launch review</h1>", { role: "title" }),
				boxHtml(
					`${lines}<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></table><blockquote><p>Ship it.</p></blockquote>`,
					{ role: "subtitle" },
				),
			],
			{ layout: "title" },
		);
		const step = await pdfStepOf(html, 1.5);
		const { file } = await powerPointFile(html);

		expect(step).toBeLessThan(1);
		const xml = await slideXml(file, 1);
		const [text, table, quote] = ["Line 1", "A", "Ship it."].map((words) =>
			shapeHolding(xml, words),
		);
		expect(runSizesOf(text ?? "")).toEqual([Math.round(2400 * step)]);
		expect(runSizesOf(quote ?? "")).toEqual([Math.round(2400 * step)]);
		expect(runSizesOf(table ?? "")).toEqual([Math.round(2000 * step)]);
		expect(table).toContain(`marT="${Math.round(0.6 * 20 * step * 12_700)}"`);
		expect(table).toContain(`marT="${Math.round(0.7 * 20 * step * 12_700)}"`);
		const [textBox, tableBox, quoteBox] = [text, table, quote].map((shape) => boxOf(shape ?? ""));
		expect(tableBox?.y).toBeGreaterThan((textBox?.y ?? 0) + 6 * 24 * step);
		expect(quoteBox?.y).toBeGreaterThan((tableBox?.y ?? 0) + (tableBox?.h ?? 0));
	});

	it("writes each paragraph's properties once and first, and each shape an id of its own, as PowerPoint reads them", async () => {
		const { file } = await powerPointFile(DECK);

		for (const xml of await slidesOf(file)) {
			for (const paragraph of paragraphsOf(xml)) {
				expect(paragraph.match(/<a:pPr\b/g)?.length ?? 0).toBeLessThanOrEqual(1);
				expect(paragraph).toMatch(/^<a:p>(<a:pPr\b|<a:r>|<a:endParaRPr)/);
			}
			const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(([, id]) => id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it("writes a file every part of which is XML, as does the PDF a file, from a deck holding what no slide shows", async () => {
		const unwritable = [0x1, 0x7, 0xb, 0xc, 0x1b, 0xd800, 0xfffe]
			.map((code) => String.fromCharCode(code))
			.join("");
		const linkedPicture = `<a href="https://example.com/?a=1&amp;b=2">${imageHtml(`Chart${unwritable}`, keptImage("image/png"))}</a>`;
		const ownStyles = new Map<string, Record<string, unknown>>([
			["tiny", { fontSize: 0.004 }],
			["huge", { fontSize: 5000 }],
			["vast", { fontSize: 1e22 }],
			["named", { fontFamily: `"Odd${unwritable} & <Font>", serif` }],
		]);
		const lineHeights = new Map([
			["Tall", 500],
			["Taller", 1e22],
		]);
		const html = slideHtml(
			[
				boxHtml(
					`<p>Bell${unwritable} ${linkedPicture}</p><p>${[...ownStyles.keys()].map((words, index) => `<span style="color: #00000${index}">${words}</span>`).join(" ")}</p><p>Tall</p><p>Taller</p>`,
					{ role: "body" },
				),
				boxHtml(
					'<table><tr><th colspan="2"><p>Wide</p></th><th><p>Third</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td><td><p>3</p></td></tr></table><table><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>Short</p></td></tr></table>',
					{ frame: { x: 8000, y: 8000, width: 300, height: 200 } },
				),
				boxHtml(
					'<ol start="0"><li><p>Zero</p></li></ol><ol start="-3"><li><p>Minus</p></li></ol><ol start="40000"><li><p>Many</p></li></ol>',
				),
				boxHtml("<p>Far</p>"),
				boxHtml(`<p>${imageHtml("Flat", keptImage("image/png"))}</p>`, {
					role: "image",
					frame: { x: 100, y: 100, width: 200, height: 0 },
				}),
			],
			{ notes: `<p>Notes${unwritable}</p>` },
		);
		const deck = deckChanged(deckOf(html), (node) => {
			const words = textIn(node);
			const style = node.type === "text" ? ownStyles.get(words) : undefined;
			if (style) return { ...node, marks: [{ type: "textStyle", attrs: style }] };
			const lineHeight = node.type === "paragraph" ? lineHeights.get(words) : undefined;
			if (lineHeight) return { ...node, attrs: { ...node.attrs, lineHeight } };
			if (node.type !== "slideBox" || words !== "Far") return node;
			return {
				...node,
				attrs: {
					...node.attrs,
					frame: { x: -1e22, y: 1e22, width: 1e22, height: 1e22 },
					padding: { top: 1e22, right: 1e22, bottom: 1e22, left: 1e22 },
					stroke: { width: 1e22, color: "#112233" },
					rotation: 1e22,
					path: "M 0 0 L 1e22 0 L 0 1e22 Z",
				},
			};
		});
		const artifact = { ...ARTIFACT, title: `Launch${unwritable}` };
		const imageOf = (image: ArtifactImageIds) => Effect.succeed(keptImages.get(image.imageId));

		const file = await JSZip.loadAsync(
			await Effect.runPromise(powerPointFileOf(artifact, deck, imageOf)),
		);
		const parts = partsMatching(file, /\.(xml|rels)$/);
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) {
			const xml = await partOf(file, part);
			expect(() => new SaxesParser({ xmlns: true }).write(xml).close(), part).not.toThrow();
		}
		expect(await partOf(file, "ppt/slides/_rels/slide1.xml.rels")).toContain(
			'Target="https://example.com/?a=1&amp;b=2"',
		);
		const xml = await slideXml(file, 1);
		expect(xml.match(/<p:pic>/g)).toHaveLength(1);
		expect(xml.match(/<a:gridCol /g)).toHaveLength(3 + 2);
		expect(xml).toContain('gridSpan="2"');
		expect([...xml.matchAll(/startAt="(\d+)"/g)].map(([, start]) => start)).toEqual([
			"1",
			"1",
			"32767",
		]);
		const pdf = await Effect.runPromise(pdfFileOf(artifact, deck, imageOf));
		expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
	});
});

/** A node of a deck as ProseMirror writes it as JSON. */
interface NodeJson {
	type: string;
	attrs?: Record<string, unknown>;
	content?: NodeJson[];
	text?: string;
	marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const textIn = (node: NodeJson): string => node.text ?? (node.content ?? []).map(textIn).join("");

/** `deck` with each of its nodes as `change` makes it, as bots and imported files may write a deck that no HTML reads as. */
function deckChanged(deck: Node, change: (node: NodeJson) => NodeJson): Node {
	const changed = (node: NodeJson): NodeJson =>
		change(node.content ? { ...node, content: node.content.map(changed) } : node);
	return deck.type.schema.nodeFromJSON(changed(deck.toJSON()));
}
