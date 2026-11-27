import { crc32, deflateSync } from "node:zlib";
import type { ArtifactImageType } from "@sugabots/contracts";
import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import type { Frame } from "@sugabots/contracts/slide-geometry";
import type { Node } from "@tiptap/pm/model";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { getDocumentProxy, getMeta, getResolvedPDFJS } from "unpdf";
import { describe, expect, it } from "vitest";
import { pdfFileOf } from "./pdf.ts";
import type { DeckImage } from "./slide-design.ts";
import { boxHtml, deckOf, slideHtml } from "./slides.test-support.ts";

/*
 * A deck's PDF, read back as a PDF reader reads it: its pages and their size,
 * the text on each in the order it is drawn, its links, its images, its
 * colours and the fonts its text is in.
 */

const ARTIFACT = {
	podId: "0199a3a0-0000-7000-8000-000000000001",
	id: "0199a3a0-0000-7000-8000-000000000002",
	title: "Launch review",
};

/** Images of each kind a deck keeps: a one-pixel PNG, a two-pixel JPEG, which a PDF holds as they are, and a WebP, which it doesn't. */
const IMAGES: Partial<Record<ArtifactImageType, Buffer>> = {
	"image/png": Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	),
	"image/jpeg": Buffer.from(
		"/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCeApRb/9k=",
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

const keptImages = new Map(
	(Object.entries(IMAGES) as [ArtifactImageType, Buffer][]).map(([type, bytes]) => [
		keptImage(type).split("/").at(-1),
		{ contentType: type, bytes } satisfies DeckImage,
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

/** A deck with a slide of each layout, holding the blocks and marks a slide can, as a bot writes one. */
const DECK = [
	slideHtml(
		[
			boxHtml("<h1>Launch review</h1>", { role: "title", verticalAlign: "bottom" }),
			boxHtml("<p>Q3, for the whole team</p>", { role: "subtitle" }),
		],
		{ layout: "title", notes: "<p>Welcome everyone.</p>" },
	),
	bulletsSlide(
		"Goals",
		[
			"<ul><li><p>Ship <em>live</em> slides</p><ul><li><p>with suggestions</p></li></ul></li>",
			"<li><p>Keep <strong>everything</strong>, <s>nothing</s> lost: <code>markdown</code>, x<sup>2</sup>, H<sub>2</sub>O, <u>this</u> and <mark>that</mark></p></li>",
			'<li><p>Read <a href="https://example.com/plan">the plan</a>, not <a href="javascript:alert(1)">this</a></p></li></ul>',
			'<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>',
			"<blockquote><p>Quoted</p></blockquote>",
			"<pre><code>bun run dev</code></pre>",
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
	slideHtml(
		[
			boxHtml("<h2>Owners</h2>", { role: "title" }),
			boxHtml(
				"<table><tr><th><p>Milestone</p></th><th><p>Owner</p></th></tr><tr><td><p>Beta</p></td><td><p>Priya</p></td></tr><tr><td><p>Launch</p></td><td><p>Marco</p></td></tr></table>",
				{ role: "table" },
			),
		],
		{ layout: "table" },
	),
].join("\n");

/** The PDF of `deck`, made at the start of 1970 by the test clock. */
const pdfOfDeck = (deck: Node) =>
	Effect.runPromise(
		pdfFileOf(ARTIFACT, deck, (image) => Effect.succeed(keptImages.get(image.imageId))).pipe(
			Effect.provide(TestClock.layer()),
		),
	);

/** The PDF of the deck `html` reads as, made at the start of 1970 by the test clock. */
const pdfFile = (html: string) => pdfOfDeck(deckOf(html));

/** The address of an image the artifact keeps under an id made from `name`. */
function keptImageNamed(name: string): string {
	const imageId = Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64);
	const ids = artifactImageIds({ podId: ARTIFACT.podId, artifactId: ARTIFACT.id, imageId });
	if (!ids) throw new Error("fixture");
	return artifactImageAddress(ids);
}

/** The PDF of the deck `html` reads as when the artifact keeps `images`, by the names their addresses are made from. */
const pdfWithImages = (html: string, images: Readonly<Record<string, DeckImage>>) =>
	Effect.runPromise(
		pdfFileOf(ARTIFACT, deckOf(html), (image) =>
			Effect.succeed(
				Object.entries(images).find(
					([name]) => keptImageNamed(name).split("/").at(-1) === image.imageId,
				)?.[1],
			),
		),
	);

function pngChunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const sum = Buffer.alloc(4);
	sum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, sum]);
}

/**
 * A PNG `width` by `height` of colour type `colorType`, whose compressed pixel
 * data is `data`, with any `chunks` of its own before it.
 */
function png(
	width: number,
	height: number,
	{
		colorType,
		data,
		chunks = [],
	}: { colorType: number; data: Uint8Array; chunks?: readonly Buffer[] },
): DeckImage {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = colorType;
	return {
		contentType: "image/png",
		bytes: Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			pngChunk("IHDR", header),
			...chunks,
			pngChunk("IDAT", data),
			pngChunk("IEND", new Uint8Array()),
		]),
	};
}

/** Rows of `width` bytes each, every one starting with the byte that says it isn't filtered. */
const rowsOf = (width: number, height: number) => Buffer.alloc((width + 1) * height);

/** A flat image with one translucent colour in its palette, which a PDF can hold only with its transparency apart. */
const translucentPng = (width: number, height: number) =>
	png(width, height, {
		colorType: 3,
		data: deflateSync(rowsOf(width, height)),
		chunks: [
			pngChunk("PLTE", Buffer.from([0x25, 0x63, 0xeb])),
			pngChunk("tRNS", Buffer.from([0x80])),
		],
	});

/** A flat RGBA image. */
const rgbaPng = (width: number, height: number) =>
	png(width, height, { colorType: 6, data: deflateSync(rowsOf(width * 4, height)) });

/** What a reader reads of each page of `file`. */
async function pagesOf(file: Uint8Array) {
	const document = await getDocumentProxy(file.slice());
	const { OPS } = await getResolvedPDFJS();
	return Promise.all(
		Array.from({ length: document.numPages }, async (_, index) => {
			const page = await document.getPage(index + 1);
			const [content, annotations, operators] = await Promise.all([
				page.getTextContent(),
				page.getAnnotations(),
				page.getOperatorList(),
			]);
			const items = content.items.flatMap((item) => ("str" in item ? [item] : []));
			const colorsSetBy = (operator: number) =>
				operators.fnArray.flatMap((each, at) =>
					each === operator ? [String(operators.argsArray[at]?.[0])] : [],
				);
			return {
				size: page.view,
				text: items
					.map((item) => `${item.str}${item.hasEOL ? " " : ""}`)
					.join("")
					.replace(/\s+/g, " ")
					.trim(),
				/** The size of each stretch of text, in points. */
				textSizes: items.map((item) => Math.hypot(item.transform[0], item.transform[1])),
				links: annotations.map((annotation) => annotation.url),
				/** How far up the page each stretch of text's baseline is, in points. */
				baselines: items.map((item) => Math.round(item.transform[5])),
				/** Each stretch of text that says something, its size, where it starts across the page and its baseline up it, in points. */
				stretches: items
					.filter((item) => item.str !== "")
					.map((item) => ({
						text: item.str,
						size: Math.hypot(item.transform[0], item.transform[1]),
						x: item.transform[4],
						baseline: item.transform[5],
					})),
				/** The colours text and shapes are filled with, and lines drawn in, as `#rrggbb`. */
				fills: colorsSetBy(OPS.setFillRGBColor),
				strokes: colorsSetBy(OPS.setStrokeRGBColor),
				images: operators.fnArray.filter((operator) => operator === OPS.paintImageXObject).length,
				/** How many stretches of text are drawn as the mark for a missing character, each marked with what it stands for. */
				missing: operators.fnArray.filter((operator) => operator === OPS.beginMarkedContentProps)
					.length,
				/** How many times text is drawn, where it shows or not, as a reader's search and copying find it. */
				textsDrawn: operators.fnArray.filter(
					(operator) => operator === OPS.showText || operator === OPS.showSpacedText,
				).length,
			};
		}),
	);
}

/** A page's height, in points; a reader measures how far up a page something is from its foot. */
const PAGE_HEIGHT = 405;

/** The points to a slide's pixel, on a page 720 points wide for a slide 960 pixels wide. */
const POINTS_PER_SLIDE_PX = 0.75;

/** Whether `stretch` of text starts inside `frame`, in a slide's pixels: across it, and its baseline between the frame's top and foot. */
const startsInside = ({ x, baseline }: { x: number; baseline: number }, frame: Frame) =>
	x >= frame.x * POINTS_PER_SLIDE_PX &&
	x < (frame.x + frame.width) * POINTS_PER_SLIDE_PX &&
	baseline < PAGE_HEIGHT - frame.y * POINTS_PER_SLIDE_PX &&
	baseline > PAGE_HEIGHT - (frame.y + frame.height) * POINTS_PER_SLIDE_PX;

/** The baseline of the stretch of text saying `text`, of a page's `stretches`. */
const baselineOf = (stretches: readonly { text: string; baseline: number }[], text: string) =>
	stretches.find((stretch) => stretch.text === text)?.baseline;

/** The app's accent colour, which a section break's bar is filled with. */
const ACCENT = "#2563eb";

/**
 * The fonts `file` holds a subset of, by name, which a PDF writes before the
 * six letters naming the subset. A font's dictionary is plain text in the file.
 */
const fontsIn = (file: Uint8Array) =>
	[
		...new Set(
			[
				...Buffer.from(file)
					.toString("latin1")
					.matchAll(/\/BaseFont \/[A-Z]{6}\+([\w-]+)/g),
			].map(([, name]) => name),
		),
	].sort();

describe("a deck's PDF", () => {
	it("is a page for each slide, in order, each the size of a 16:9 slide, its words real text", async () => {
		const pages = await pagesOf(await pdfFile(DECK));

		expect(pages.map(({ size }) => size)).toEqual(Array(7).fill([0, 0, 720, 405]));
		expect(pages.map(({ text }) => text)).toEqual([
			"Launch review Q3, for the whole team",
			"Goals Ship live slides with suggestions Keep everything, nothing lost: markdown , x2, H2O, this and that Read the plan, not this 3. Third 4. Fourth Quoted bun run dev",
			"People and bots People Type in the page Bots 1. Suggest changes",
			"The chart Sales went up.",
			"Part 2 Where we are",
			"Nothing a person writes is lost. The team",
			"Owners Milestone Owner Beta Priya Launch Marco",
		]);
	});

	it("holds the app's fonts at the weights its slides draw, and none of the speaker notes", async () => {
		const file = await pdfFile(DECK);

		expect(fontsIn(file)).toEqual([
			"JetBrainsMono-Regular",
			"Rubik-Bold",
			"Rubik-Italic",
			"Rubik-Medium",
			"Rubik-Regular",
			"Rubik-SemiBold",
		]);
		const [title] = await pagesOf(file);
		expect(title?.text).not.toContain("Welcome");
	});

	it("links text where a link may go, and nowhere else", async () => {
		const pages = await pagesOf(await pdfFile(DECK));

		expect(pages.map(({ links }) => links)).toEqual([
			[],
			["https://example.com/plan"],
			[],
			[],
			[],
			[],
			[],
		]);
	});

	it("draws a section break's accent bar over its label, and none on a slide without one", async () => {
		const pages = await pagesOf(await pdfFile(DECK));

		expect(pages[4]?.fills).toContain(ACCENT);
		expect(pages[1]?.fills).not.toContain(ACCENT);
	});

	it("draws the deck's own PNG and JPEG images, and any other image as its words", async () => {
		const [slide] = await pagesOf(
			await pdfFile(
				slideHtml(
					[
						boxHtml("<h2>Charts</h2>", { role: "title" }),
						boxHtml(
							`<p>${imageHtml("Theirs", keptImage("image/png", "0199a3a0-0000-7000-8000-000000000009"))} and ${imageHtml("A WebP chart", keptImage("image/webp"))}</p>`,
							{ role: "text" },
						),
						boxHtml(
							`<p>${imageHtml("The launch chart", keptImage("image/png"))}</p><p><a href="https://example.com/photo">${imageHtml("The photo", keptImage("image/jpeg"))}</a></p>`,
							{ role: "image", verticalAlign: "middle" },
						),
					],
					{ layout: "image" },
				),
			),
		);

		expect(slide?.images).toBe(2);
		expect(slide?.text).toBe("Charts Theirs and A WebP chart");
		expect(slide?.links).toEqual(["https://example.com/photo"]);
	});

	it("draws a slide's text a step smaller while it doesn't fit, and cuts off what still runs over, on its one page", async () => {
		const points = Array.from({ length: 30 }, (_, index) => `Point ${index + 1}`);
		const pages = await pagesOf(
			await pdfFile(
				[
					bulletsSlide("Short", listHtml("ul", ["Point"])),
					bulletsSlide("Long", listHtml("ul", points)),
				].join(""),
			),
		);

		expect(pages).toHaveLength(2);
		const [short, long] = pages;
		// A bullet's text is 1.5 units, a unit being a 60th of the slide's 720 points.
		expect(short?.textSizes.at(-1)).toBeCloseTo(18);
		expect(long?.textSizes.at(-1)).toBeCloseTo(18 * 0.7);
		expect(long?.text).toContain("Point 1 ");
		expect(long?.text).not.toContain("Point 30");
	});

	it("keeps a file whole around text its fonts have no characters for", async () => {
		const [slide] = await pagesOf(
			await pdfFile(
				slideHtml([boxHtml("<h1>Ünïcödé Łódź жизнь 日本語 😀👍🏽</h1><p>The rest</p>")]),
			),
		);

		expect(slide?.text).toMatch(/^Ünïcödé Łódź жизнь .* The rest$/);
	});

	it("gives a deck that says nothing a blank page", async () => {
		const pages = await pagesOf(await pdfFile(""));

		expect(pages).toEqual([expect.objectContaining({ size: [0, 0, 720, 405], text: "" })]);
	});

	it("draws an image with more pixels than may be unpacked to draw it as its words, and a screenshot as itself", async () => {
		const [slide] = await pagesOf(
			await pdfWithImages(
				bulletsSlide(
					"Charts",
					`<p>${imageHtml("A huge chart", keptImageNamed("huge"))}</p><p>${imageHtml("A screenshot", keptImageNamed("screen"))}</p>`,
				),
				{ huge: translucentPng(6000, 4200), screen: rgbaPng(1920, 1080) },
			),
		);

		expect(slide?.images).toBe(1);
		expect(slide?.text).toBe("Charts A huge chart");
	});

	it("draws a damaged image as its words, and the rest of the deck", async () => {
		const zeroWideJpeg: DeckImage = {
			contentType: "image/jpeg",
			bytes: Buffer.from([
				0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00,
				0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
			]),
		};
		const pages = await pagesOf(
			await pdfWithImages(
				[
					bulletsSlide(
						"Damaged",
						`<p>${imageHtml("Bad pixels", keptImageNamed("bad"))}</p><p>${imageHtml("No width", keptImageNamed("zero"))}</p>`,
					),
					bulletsSlide("Next", ""),
				].join(""),
				{
					bad: png(64, 64, { colorType: 6, data: Buffer.from("not deflate data at all") }),
					zero: zeroWideJpeg,
				},
			),
		);

		expect(pages.map(({ text, images }) => ({ text, images }))).toEqual([
			{ text: "Damaged Bad pixels No width", images: 0 },
			{ text: "Next", images: 0 },
		]);
	});

	it("links only to absolute addresses, written as a reader can follow them, wherever the file is saved", async () => {
		const [slide] = await pagesOf(
			await pdfFile(
				bulletsSlide(
					"Links",
					'<p><a href="/pods/abc/artifacts/def">in the app</a> <a href="plan.pdf">beside it</a> <a href="../secret.txt">up</a> <a href="#top">here</a> <a href="https://example.com/café?q=日本">café</a> <a href="mailto:team@example.com">mail</a></p>',
				),
			),
		);

		expect(slide?.text).toBe("Links in the app beside it up here café mail");
		expect(slide?.links).toEqual([
			"https://example.com/caf%C3%A9?q=%E6%97%A5%E6%9C%AC",
			"mailto:team@example.com",
		]);
	});

	it("lays out a word far longer than its line, in a cell of a wide table", async () => {
		const columns = 40;
		const row = (tag: "th" | "td", cells: readonly string[]) =>
			`<tr>${cells.map((cell) => `<${tag}><p>${cell}</p></${tag}>`).join("")}</tr>`;
		const cells = Array.from({ length: columns }, (_, index) =>
			index === 0 ? "y".repeat(130_000) : "x",
		);
		const [slide] = await pagesOf(
			await pdfFile(
				bulletsSlide(
					"Wide",
					`<table>${row("th", Array(columns).fill("H"))}${row("td", cells)}</table>`,
				),
			),
		);

		expect(slide?.text).toMatch(/^Wide H H/);
	});

	it("leaves out what is past the foot of the slide, numbers and all", async () => {
		const list = (length: number) =>
			bulletsSlide(
				"Long",
				listHtml(
					"ol",
					Array.from({ length }, (_, index) => `Item ${index + 1}`),
				),
			);
		const [short, long] = await pagesOf(await pdfFile(`${list(20)}${list(400)}`));

		expect(long?.text).toBe(short?.text);
		expect(long?.textsDrawn).toBe(short?.textsDrawn);
	});

	it("draws symbols in fonts that hold them, and characters that show nothing as nothing", async () => {
		const file = await pdfFile(
			bulletsSlide(
				"Plan A → B ✓",
				"<p>π ≥ 3 ≠ ∞ ★ ✗ <strong>Δ ⇒ α</strong> co&#x200b;operate soft&#xad;hyphen 10&#x2009;000</p><table><tr><th><p>Done</p></th><th><p>Next</p></th></tr><tr><td><p>✓</p></td><td><p>→ <code>a ≤ b</code></p></td></tr></table><p>first&#x2028;second</p>",
			),
		);
		const fonts = fontsIn(file);
		const [slide] = await pagesOf(file);

		expect(slide?.missing).toBe(0);
		expect(fonts).toEqual(
			expect.arrayContaining(["NotoSans-Bold", "NotoSansMath-Regular", "NotoSansSymbols2-Regular"]),
		);
		expect(slide?.text).toContain("cooperate softhyphen");
		const baselines = slide?.baselines ?? [];
		expect(new Set(baselines.slice(-2)).size).toBe(2);
	});

	it("draws each box at its frame on the slide's background, filled and outlined, and text of its own colour and size as it says", async () => {
		const title = { x: 480, y: 300, width: 400, height: 60 };
		const list = { x: 80, y: 64, width: 360, height: 200 };
		const deck = deckOf(
			slideHtml(
				[
					boxHtml("<h2>Goals</h2>", {
						role: "title",
						frame: title,
						style: "background: #1e3a8a; border: 2px solid #93c5fd",
					}),
					boxHtml(
						'<ul><li><p><span style="color: #fbbf24; font-size: 40px">Ship it</span></p></li></ul>',
						{ role: "body", frame: list },
					),
				],
				{ layout: "bullets", background: "#0f172a" },
			),
		);

		const [slide] = await pagesOf(await pdfOfDeck(deck));

		const [goals, shipIt] = ["Goals", "Ship it"].map((text) =>
			slide?.stretches.find((stretch) => stretch.text === text),
		);
		// A heading starts at the left of its box, within its outline.
		expect(goals?.x).toBeCloseTo((title.x + 2) * POINTS_PER_SLIDE_PX);
		expect(goals && startsInside(goals, title)).toBe(true);
		expect(shipIt && startsInside(shipIt, list)).toBe(true);
		expect(shipIt?.size).toBeCloseTo(40 * POINTS_PER_SLIDE_PX);
		expect(slide?.fills).toEqual(expect.arrayContaining(["#0f172a", "#1e3a8a", "#fbbf24"]));
		expect(slide?.strokes).toContain("#93c5fd");
	});

	it("keeps a box's text at full size where it runs past its frame into room below it, and steps it down where a box below leaves it none", async () => {
		const points = listHtml(
			"ul",
			Array.from({ length: 6 }, (_, index) => `Point ${index + 1}`),
		);
		const list = { x: 80, y: 142, width: 800, height: 60 };
		const slideWith = (titleFrame: Frame, listFrame: Frame) =>
			slideHtml(
				[
					boxHtml("<h2>Points</h2>", { role: "title", frame: titleFrame }),
					boxHtml(points, { role: "body", frame: listFrame }),
				],
				{ layout: "bullets" },
			);
		const roomy = slideWith({ x: 80, y: 64, width: 800, height: 46 }, list);
		// The title placed just under the list's frame, across the same width.
		const crowded = slideWith(
			{ x: 80, y: 130, width: 800, height: 46 },
			{ x: 80, y: 64, width: 800, height: 60 },
		);

		const [roomyPage] = await pagesOf(await pdfFile(roomy));
		const [crowdedPage] = await pagesOf(await pdfFile(crowded));

		// A bullet's text is 1.5 units, a unit being a 60th of the slide's 720 points.
		expect(roomyPage?.textSizes.at(-1)).toBeCloseTo(18);
		expect(baselineOf(roomyPage?.stretches ?? [], "Point 6")).toBeLessThan(
			PAGE_HEIGHT - (list.y + list.height) * POINTS_PER_SLIDE_PX,
		);
		expect(crowdedPage?.textSizes.at(-1)).toBeCloseTo(18 * 0.7);
	});

	it("is the same file each time, titled as the deck, and naming nobody", async () => {
		const [first, second] = await Promise.all([pdfFile(DECK), pdfFile(DECK)]);

		expect(Buffer.from(first ?? []).equals(Buffer.from(second ?? []))).toBe(true);
		const { info } = await getMeta(first.slice());
		expect(info).toMatchObject({ Title: "Launch review", CreationDate: "D:19700101000000Z" });
		expect(info).not.toHaveProperty("Author");
	});
});
