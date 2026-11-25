import { crc32, deflateSync } from "node:zlib";
import type { ArtifactImageType } from "@sugabots/contracts";
import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { getDocumentProxy, getMeta, getResolvedPDFJS } from "unpdf";
import { describe, expect, it } from "vitest";
import { pdfFileOf } from "./pdf.ts";
import type { DeckImage } from "./slide-design.ts";

/*
 * A deck's PDF, read back as a PDF reader reads it: its pages and their size,
 * the text on each in the order it is drawn, its links, its images and the
 * fonts its text is in.
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

/** A deck with a slide of each layout, holding the blocks and marks a slide can, as a bot writes one. */
const DECK = [
	"<!-- layout: title -->\n\n# Launch review\n\nQ3, for the whole team\n\n<!-- notes: Welcome everyone. -->",
	[
		"<!-- layout: bullets -->",
		"## Goals",
		"- Ship *live* slides\n  - with suggestions\n- Keep **everything**, ~~nothing~~ lost: `markdown`, x<sup>2</sup>, H<sub>2</sub>O, <u>this</u> and <mark>that</mark>\n- Read [the plan](https://example.com/plan), not [this](javascript:alert(1))",
		"3. Third\n4. Fourth",
		"> Quoted",
		"```\nbun run dev\n```",
	].join("\n\n"),
	"<!-- layout: columns -->\n\n## People and bots\n\n<!-- column -->\n\n### People\n\n- Type in the page\n\n<!-- column -->\n\n### Bots\n\n1. Suggest changes",
	`<!-- layout: image -->\n\n## The chart\n\n<!-- column -->\n\nSales went up.\n\n<!-- column -->\n\n![The launch chart](${keptImage("image/png")})`,
	"<!-- layout: section -->\n\nPart 2\n\n## Where we are",
	"<!-- layout: quote -->\n\n> Nothing a person writes is lost.\n\nThe team",
	"<!-- layout: table -->\n\n## Owners\n\n| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |\n| Launch | Marco |",
].join("\n\n---\n\n");

/** The PDF of `markdown`, made at the start of 1970 by the test clock. */
const pdfFile = (markdown: string) =>
	Effect.runPromise(
		pdfFileOf(ARTIFACT, markdown, (image) => Effect.succeed(keptImages.get(image.imageId))).pipe(
			Effect.provide(TestClock.layer()),
		),
	);

/** The address of an image the artifact keeps under an id made from `name`. */
function keptImageNamed(name: string): string {
	const imageId = Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64);
	const ids = artifactImageIds({ podId: ARTIFACT.podId, artifactId: ARTIFACT.id, imageId });
	if (!ids) throw new Error("fixture");
	return artifactImageAddress(ids);
}

/** The PDF of `markdown` when the artifact keeps `images`, by the names their addresses are made from. */
const pdfWithImages = (markdown: string, images: Readonly<Record<string, DeckImage>>) =>
	Effect.runPromise(
		pdfFileOf(ARTIFACT, markdown, (image) =>
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

	it("draws the deck's own PNG and JPEG images, and any other image as its words", async () => {
		const [slide] = await pagesOf(
			await pdfFile(
				[
					"<!-- layout: image -->",
					"## Charts",
					"<!-- column -->",
					`![Theirs](${keptImage("image/png", "0199a3a0-0000-7000-8000-000000000009")}) and ![A WebP chart](${keptImage("image/webp")})`,
					"<!-- column -->",
					`![The launch chart](${keptImage("image/png")})`,
					`[![The photo](${keptImage("image/jpeg")})](https://example.com/photo)`,
				].join("\n\n"),
			),
		);

		expect(slide?.images).toBe(2);
		expect(slide?.text).toBe("Charts Theirs and A WebP chart");
		expect(slide?.links).toEqual(["https://example.com/photo"]);
	});

	it("draws a slide's text a step smaller while it doesn't fit, and cuts off what still runs over, on its one page", async () => {
		const points = Array.from({ length: 30 }, (_, index) => `- Point ${index + 1}`).join("\n");
		const pages = await pagesOf(
			await pdfFile(`## Short\n\n- Point\n\n---\n\n## Long\n\n${points}`),
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
		const [slide] = await pagesOf(await pdfFile("# Ünïcödé Łódź жизнь 日本語 😀👍🏽\n\nThe rest"));

		expect(slide?.text).toMatch(/^Ünïcödé Łódź жизнь .* The rest$/);
	});

	it("gives a deck that says nothing a blank page", async () => {
		const pages = await pagesOf(await pdfFile(""));

		expect(pages).toEqual([expect.objectContaining({ size: [0, 0, 720, 405], text: "" })]);
	});

	it("draws an image with more pixels than may be unpacked to draw it as its words, and a screenshot as itself", async () => {
		const [slide] = await pagesOf(
			await pdfWithImages(
				`## Charts\n\n![A huge chart](${keptImageNamed("huge")})\n\n![A screenshot](${keptImageNamed("screen")})`,
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
				`## Damaged\n\n![Bad pixels](${keptImageNamed("bad")})\n\n![No width](${keptImageNamed("zero")})\n\n---\n\n## Next`,
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
				"## Links\n\n[in the app](/pods/abc/artifacts/def) [beside it](plan.pdf) [up](../secret.txt) [here](#top) [café](https://example.com/café?q=日本) [mail](mailto:team@example.com)",
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
		const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
		const cells = Array.from({ length: columns }, (_, index) =>
			index === 0 ? "y".repeat(130_000) : "x",
		);
		const [slide] = await pagesOf(
			await pdfFile(
				`## Wide\n\n${row(Array(columns).fill("H"))}\n${row(Array(columns).fill("---"))}\n${row(cells)}`,
			),
		);

		expect(slide?.text).toMatch(/^Wide H H/);
	});

	it("leaves out what is past the foot of the slide, numbers and all", async () => {
		const list = (length: number) =>
			`## Long\n\n${Array.from({ length }, (_, index) => `${index + 1}. Item ${index + 1}`).join("\n")}`;
		const [short, long] = await pagesOf(await pdfFile(`${list(20)}\n\n---\n\n${list(400)}`));

		expect(long?.text).toBe(short?.text);
		expect(long?.textsDrawn).toBe(short?.textsDrawn);
	});

	it("draws symbols in fonts that hold them, and characters that show nothing as nothing", async () => {
		const file = await pdfFile(
			"## Plan A → B ✓\n\nπ ≥ 3 ≠ ∞ ★ ✗ **Δ ⇒ α** co\u200boperate soft\u00adhyphen 10\u2009000\n\n| Done | Next |\n| --- | --- |\n| ✓ | → `a ≤ b` |\n\nfirst\u2028second",
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

	it("is the same file each time, titled as the deck, and naming nobody", async () => {
		const [first, second] = await Promise.all([pdfFile(DECK), pdfFile(DECK)]);

		expect(Buffer.from(first ?? []).equals(Buffer.from(second ?? []))).toBe(true);
		const { info } = await getMeta(first.slice());
		expect(info).toMatchObject({ Title: "Launch review", CreationDate: "D:19700101000000Z" });
		expect(info).not.toHaveProperty("Author");
	});
});
