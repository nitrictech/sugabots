import type { ArtifactImageType } from "@sugabots/contracts";
import {
	type ArtifactImageIds,
	artifactImageAddress,
	artifactImageIds,
} from "@sugabots/contracts/http";
import { Effect } from "effect";
import JSZip from "jszip";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { pdfFileOf } from "./pdf.ts";
import { type PowerPointImage, powerPointFileOf } from "./powerpoint.ts";

/*
 * A deck's PowerPoint file, read back from its XML, as PowerPoint reads it:
 * which layout each slide is on, which placeholder holds what, and the runs,
 * lists, tables, pictures and notes PowerPoint makes of them.
 */

const ARTIFACT = {
	podId: "0199a3a0-0000-7000-8000-000000000001",
	id: "0199a3a0-0000-7000-8000-000000000002",
	title: "Launch review",
};

/** One-pixel images of two kinds a deck keeps: one PowerPoint draws, and one it may not. */
const IMAGES: Partial<Record<ArtifactImageType, Buffer>> = {
	"image/png": Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
	"image/webp": Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64"),
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

/** A deck with a slide of each layout, as a bot writes one. */
const DECK = [
	"<!-- layout: title -->\n\n# Launch review\n\nQ3, for the whole team\n\n<!-- notes: Welcome everyone.\n\nSay the **new** pod's name. -->",
	[
		"<!-- layout: bullets -->",
		"## Goals",
		"- Ship *live* slides\n  - with suggestions\n  - and notes\n- Keep **everything**, ~~nothing~~ lost: `markdown`, x<sup>2</sup>, H<sub>2</sub>O, <u>this</u> and <mark>that</mark>\n- Read [the plan](https://example.com/plan), not [this](javascript:alert(1))",
		"3. Third\n4. Fourth",
	].join("\n\n"),
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- column -->\n\n### People\n\n- Type in the page\n\n<!-- column -->\n\n### Bots\n\n1. Suggest changes",
	`<!-- layout: image -->\n\n## The chart\n\n<!-- column -->\n\nSales went up.\n\n<!-- column -->\n\n![The launch chart](${keptImage("image/png")})`,
	"<!-- layout: section -->\n\n## Where we are",
	"<!-- layout: quote -->\n\n> Nothing a person writes is lost.\n\nThe team",
	"<!-- layout: table -->\n\n## Owners\n\n| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |\n| Launch | Marco |",
].join("\n\n---\n\n");

/** The PowerPoint file of `markdown`, and the images it asked for. */
async function powerPointFile(markdown: string) {
	const asked: ArtifactImageIds[] = [];
	const file = await Effect.runPromise(
		powerPointFileOf(ARTIFACT, markdown, (image) => {
			asked.push(image);
			return Effect.succeed(keptImages.get(image.imageId));
		}),
	);
	return { file: await JSZip.loadAsync(file), asked };
}

type File = JSZip;

const partOf = async (file: File, part: string) => (await file.file(part)?.async("string")) ?? "";

const slideXml = (file: File, number: number) => partOf(file, `ppt/slides/slide${number}.xml`);

/** The parts of `file` whose paths match `path`, sorted by their number. */
const partsMatching = (file: File, path: RegExp) =>
	Object.keys(file.files)
		.filter((name) => path.test(name))
		.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));

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
		/<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)?.slice(1) ?? []
	).map((emus) => Number(emus) / 12_700);
	return { x, y, w, h };
}

/**
 * The step the deck's PDF draws its first slide's text at: the size of its
 * last stretch of text, which is text of `fullSize` units at full size, over
 * that full size, on a PDF page 720 points wide, which is 12 to the unit.
 */
async function pdfStepOf(markdown: string, fullSize: number): Promise<number> {
	const file = await Effect.runPromise(
		pdfFileOf(ARTIFACT, markdown, () => Effect.succeed(undefined)),
	);
	const page = await (await getDocumentProxy(file.slice())).getPage(1);
	const last = (await page.getTextContent()).items
		.flatMap((item) => ("str" in item ? [item] : []))
		.at(-1);
	return Math.hypot(last?.transform[0] ?? 0, last?.transform[1] ?? 0) / (fullSize * 12);
}

/** The owner's own deck's first slide: a paragraph and four bullets with bold lead-ins in one column, and an empty table in the other. */
const TWO_COLUMNS = [
	"<!-- layout: columns -->",
	"## One page for people and bots",
	"<!-- column -->",
	"Shared documents let a team and its bots write one page together, without anyone losing work.",
	[
		"- **What it is:** one page that people and bots edit side by side.",
		"- **Who it is for:** teams that already use bots to draft, review and tidy documents.",
		"- **What changes:** edits from bots arrive as suggestions, so people stay in control.",
		"- **Where we start:** our own workspaces, then teams who asked to join.",
	].join("\n"),
	"<!-- column -->",
	"|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
].join("\n\n");

const LAYOUT_NAMES = [
	"Title",
	"Title and bullets",
	"Two columns",
	"Image and text",
	"Section break",
	"Quote",
	"Table",
];

describe("a deck's PowerPoint file", () => {
	it("holds a slide for each of the deck's, in order, each on its own layout, and no layout but the deck's", async () => {
		const { file } = await powerPointFile(DECK);

		const slides = partsMatching(file, /^ppt\/slides\/slide\d+\.xml$/);
		const layoutsOfSlides = await Promise.all(
			slides.map(async (_slide, index) =>
				nameOf(await partOf(file, await layoutPartOf(file, index + 1))),
			),
		);
		expect(layoutsOfSlides).toEqual(LAYOUT_NAMES);
		const layouts = await Promise.all(
			partsMatching(file, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/).map(async (part) =>
				nameOf(await partOf(file, part)),
			),
		);
		expect(layouts).toEqual(LAYOUT_NAMES);
		const master = await partOf(file, "ppt/slideMasters/slideMaster1.xml");
		expect(master.match(/<p:sldLayoutId /g)).toHaveLength(LAYOUT_NAMES.length);
	});

	it("puts each slide's title and text in its layout's placeholders", async () => {
		const { file } = await powerPointFile(DECK);

		const slides = await Promise.all(LAYOUT_NAMES.map((_name, index) => slideXml(file, index + 1)));
		expect(slides.map(filledPlaceholders)).toEqual([
			[
				["title", ["Launch review"]],
				["body", ["Q3, for the whole team"]],
			],
			[
				["title", ["Goals"]],
				[
					"body",
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
			],
			[
				["title", ["People and bots"]],
				["body", ["People", "Type in the page"]],
				["body", ["Bots", "Suggest changes"]],
			],
			[
				["title", ["The chart"]],
				["body", ["Sales went up."]],
			],
			[["title", ["Where we are"]]],
			[
				["title", ["Nothing a person writes is lost."]],
				["body", ["The team"]],
			],
			[["title", ["Owners"]]],
		]);
		for (const [index, slide] of slides.entries()) {
			const layout = shapesOf(await partOf(file, await layoutPartOf(file, index + 1)));
			for (const shape of shapesOf(slide).filter((each) => each.includes("<p:ph"))) {
				expect(layout.map(placeholderOf)).toContainEqual(placeholderOf(shape));
			}
		}
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
			"## Links\n\n[in the app](/pods/abc/artifacts/def) [beside it](plan.pdf) [here](#top) [café](https://example.com/café?q=日本)",
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

	it("holds the deck's own image with its words, and gives any other image, or one PowerPoint may not draw, as its words", async () => {
		const { file, asked } = await powerPointFile(
			[
				"<!-- layout: image -->",
				"## Charts",
				"<!-- column -->",
				`![Theirs](${keptImage("image/png", "0199a3a0-0000-7000-8000-000000000009")}) and ![A WebP chart](${keptImage("image/webp")})`,
				"<!-- column -->",
				`![The launch chart](${keptImage("image/png")})`,
			].join("\n\n"),
		);

		expect(asked.map(({ artifactId }) => artifactId)).toEqual([ARTIFACT.id, ARTIFACT.id]);
		const media = partsMatching(file, /^ppt\/media\//);
		expect(media).toHaveLength(1);
		expect(await file.file(media[0] ?? "")?.async("nodebuffer")).toEqual(IMAGES["image/png"]);
		const xml = await slideXml(file, 1);
		expect(xml.match(/<p:pic>/g)).toHaveLength(1);
		expect(xml).toMatch(/<p:cNvPr id="\d+" name="[^"]*" descr="The launch chart">/);
		expect(filledPlaceholders(xml)).toEqual([
			["title", ["Charts"]],
			["body", ["Theirs and A WebP chart"]],
		]);
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

	it("keeps on its slide what its layout has no place for, apart from its placeholders", async () => {
		const { file } = await powerPointFile(
			"<!-- layout: title -->\n\n# Launch review\n\nQ3\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> Ship it.\n\n```\nbun run dev\n```",
		);

		const xml = await slideXml(file, 1);
		expect(filledPlaceholders(xml)).toEqual([["title", ["Launch review"]]]);
		expect(xml).toContain("<a:tbl>");
		const boxes = shapesOf(xml).filter((shape) => shape.includes('txBox="1"'));
		expect(boxes.map((box) => paragraphsOf(box).map(textOf))).toEqual([
			["Q3"],
			["Ship it.", "bun run dev"],
		]);
		expect(runHolding(xml, "Ship it.")).toMatch(/<a:rPr [^>]*\bi="1"/);
		expect(runHolding(xml, "bun run dev")).toContain('<a:latin typeface="Courier New"');
		expect(shapesOf(xml).filter((shape) => shape.includes("<p:ph"))).toHaveLength(1);
	});

	it("states each region's alignment as the app draws it, to the left but for the image's column, leaving nothing to a centred default", async () => {
		const { file } = await powerPointFile(DECK);

		const slides = await Promise.all(LAYOUT_NAMES.map((_name, index) => slideXml(file, index + 1)));
		for (const xml of slides) {
			for (const paragraph of paragraphsOf(xml)) expect(paragraph).toMatch(/^<a:p><a:pPr algn="l"/);
		}
		const layouts = await Promise.all(
			partsMatching(file, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/).map((part) =>
				partOf(file, part),
			),
		);
		expect(
			layouts.map((xml) => [
				nameOf(xml),
				[...xml.matchAll(/<a:lvl1pPr\b[^>]*>/g)].map(
					([style]) => /\balgn="(\w+)"/.exec(style)?.[1],
				),
			]),
		).toEqual([
			["Title", ["l", "l"]],
			["Title and bullets", ["l", "l"]],
			["Two columns", ["l", "l", "l"]],
			["Image and text", ["l", "l", "ctr"]],
			["Section break", ["l", "l"]],
			["Quote", ["l", "l"]],
			["Table", ["l", "l"]],
		]);
		const master = await partOf(file, "ppt/slideMasters/slideMaster1.xml");
		expect(/<p:titleStyle>\s*<a:lvl1pPr\b[^>]*>/.exec(master)?.[0]).toContain('algn="l"');
		expect(/<p:bodyStyle>[\s\S]*<\/p:bodyStyle>/.exec(master)?.[0]).not.toMatch(
			/<a:spcBef><a:spcPct val="[1-9]/,
		);
	});

	it("sets a slide's text at full size where it fits, the text under the title as far below it as the app sets it", async () => {
		const { file } = await powerPointFile("## Goals\n\n- Ship it\n- Keep it");

		const xml = await slideXml(file, 1);
		expect(runSizesOf(shapeHolding(xml, "Goals"))).toEqual([4000]);
		expect(runSizesOf(shapeHolding(xml, "Ship it"))).toEqual([2400]);
		// The padding is 4 units of 16 points, the title a line of 2.5 units at 1.15, and the gap under it 2 units.
		expect(boxOf(shapeHolding(xml, "Ship it")).y).toBeCloseTo(64 + 40 * 1.15 + 32);
	});

	it("sets the text of a slide too long for full size at the step the PDF draws it at, every region placed for that step", async () => {
		const step = await pdfStepOf(TWO_COLUMNS, 1.25);
		const { file } = await powerPointFile(TWO_COLUMNS);

		expect(step).toBeCloseTo(0.9);
		const xml = await slideXml(file, 1);
		const left = shapeHolding(xml, "What it is:");
		expect(runSizesOf(shapeHolding(xml, "One page for people and bots"))).toEqual([
			Math.round(4000 * step),
		]);
		expect(runSizesOf(left)).toEqual([Math.round(2000 * step)]);
		const unit = 16 * step;
		const title = boxOf(shapeHolding(xml, "One page for people and bots"));
		const table = boxOf(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/.exec(xml)?.[0] ?? "");
		expect(title.y).toBeCloseTo(64);
		expect(boxOf(left).y).toBeCloseTo(64 + 2.5 * unit * 1.15 + 2 * unit);
		expect(table.y).toBeCloseTo(boxOf(left).y);
		expect(table.x - (boxOf(left).x + boxOf(left).w)).toBeCloseTo(3.5 * unit);
		expect(xml).toContain(`marL="${Math.round(0.8 * 20 * step * 12_700)}"`);
	});

	it("sets the text of a slide that fits only at the smallest step at that step", async () => {
		const points = Array.from({ length: 10 }, (_, index) => `- Point ${index + 1}`).join("\n");
		const markdown = `## Points\n\n${points}`;
		const step = await pdfStepOf(markdown, 1.5);
		const { file } = await powerPointFile(markdown);

		expect(step).toBeCloseTo(0.7);
		const xml = await slideXml(file, 1);
		expect(runSizesOf(shapeHolding(xml, "Points"))).toEqual([Math.round(4000 * step)]);
		expect(runSizesOf(shapeHolding(xml, "Point 10"))).toEqual([Math.round(2400 * step)]);
	});

	it("sets a table's text and padding, and what is stacked in boxes of its own, at the slide's step", async () => {
		const lines = Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join("\n\n");
		const markdown = `<!-- layout: title -->\n\n# Launch review\n\n${lines}\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> Ship it.`;
		const step = await pdfStepOf(markdown, 1.5);
		const { file } = await powerPointFile(markdown);

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

		const slides = await Promise.all(LAYOUT_NAMES.map((_name, index) => slideXml(file, index + 1)));
		for (const xml of slides) {
			for (const paragraph of paragraphsOf(xml)) {
				expect(paragraph.match(/<a:pPr\b/g)?.length ?? 0).toBeLessThanOrEqual(1);
				expect(paragraph).toMatch(/^<a:p>(<a:pPr\b|<a:r>|<a:endParaRPr)/);
			}
			const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(([, id]) => id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});
});
