import { artifactImageAddress, artifactImageIds } from "@sugabots/contracts/http";
import {
	liveDocumentFromMarkdown,
	liveDocumentSchema,
	markdownOfLiveDocument,
} from "@sugabots/contracts/live-document-markdown";
import { layoutOf } from "@sugabots/contracts/live-slides";
import { powerPointFileOf } from "@sugabots/core/artifacts/powerpoint";
import type { Node } from "@tiptap/pm/model";
import { Effect } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ImageNotKept, type KeepableImage } from "@/lib/file-import.ts";
import { deckFromPowerPoint } from "@/lib/powerpoint-import.ts";
import {
	powerPointImportTestFile,
	TEST_LINK,
	TEST_PICTURE,
} from "./powerpoint-import-test-file.ts";

/*
 * What a PowerPoint file's import keeps, read back as the markdown the deck
 * is kept in: each slide's layout, its title as its heading, its words, lists
 * and tables, its images and its notes, and what it counts as left out.
 */

// The app is bundled with pptxtojson's ES module, which Vite takes by its
// `module` field. Node, which the tests run in, takes its UMD build by `main`,
// whose exports it can't find by name.
vi.mock("pptxtojson", () => import("pptxtojson/dist/index.js"));

const schema = liveDocumentSchema("slides");

/** Imports `file`, keeping each image at an address of its own, numbered in the order it was kept. */
async function imported(file: ArrayBuffer) {
	const kept: KeepableImage[] = [];
	const result = await deckFromPowerPoint(file, schema, async (image) => {
		kept.push(image);
		return `/images/${kept.length}`;
	});
	return { ...result, kept, slides: slidesInMarkdown(result.deck) };
}

/** Each slide of `deck` as its markdown. */
const slidesInMarkdown = (deck: Node) => markdownOfLiveDocument(deck).split("\n\n---\n\n");

const lines = (...each: string[]) => each.join("\n\n");

describe("importing a PowerPoint file", () => {
	let deck: Awaited<ReturnType<typeof imported>>;
	beforeAll(async () => {
		deck = await imported(await powerPointImportTestFile());
	});

	it("makes a slide of each of the file's, in order, each laid out by what it held", () => {
		expect(deck.deck.children.map(layoutOf)).toEqual([
			"title",
			"bullets",
			"columns",
			"image",
			"table",
			"image",
			"bullets",
			"quote",
			"section",
			"bullets",
		]);
	});

	it("takes the short line in the largest type for the title, the line under it for its subtitle, and keeps the notes a paragraph a line", () => {
		expect(deck.slides[0]).toBe(
			lines(
				"<!-- layout: title -->",
				"# Quarterly review",
				"Q3, for the whole team",
				"<!-- notes: Welcome everyone.",
				"Say the new pod's name. -->",
			),
		);
	});

	it("keeps bullets and numbers at their levels, with bold, italics, underline, strikethrough, superscript, subscript and links, and leaves out the slide's number", () => {
		expect(deck.slides[1]).toBe(
			lines(
				"<!-- layout: bullets -->",
				"## Goals",
				[
					"- Ship *live* slides",
					"  - with suggestions",
					"  - and notes",
					`- Keep **everything**, see [the plan](${TEST_LINK})`,
					"- x<sup>2</sup> and H<sub>2</sub>O, <u>underlined</u> and ~~struck~~",
				].join("\n"),
				"1. Write it\n2. Ship it",
				"<!-- notes: Keep this one short. -->",
			),
		);
	});

	it("lays two boxes of words side by side out in two columns", () => {
		expect(deck.slides[2]).toBe(
			lines(
				"<!-- layout: columns -->",
				"## People and bots",
				"<!-- column -->",
				"**People**",
				"Type in the page at the same time.",
				"<!-- column -->",
				"**Bots**",
				"Suggest changes to accept or undo.",
			),
		);
	});

	it("keeps a picture, with its words, in the image layout beside the words it sat beside, keeping the same picture once", () => {
		expect(deck.slides[3]).toBe(
			lines(
				"<!-- layout: image -->",
				"## Sales went up",
				"<!-- column -->",
				"Every region grew, the north most of all.",
				"<!-- column -->",
				"![The sales chart](/images/1)",
			),
		);
		expect(deck.slides[5]).toBe(
			lines("<!-- layout: image -->", "<!-- column -->", "<!-- column -->", "![](/images/1)"),
		);
		expect(deck.kept).toEqual([{ type: "image/png", bytes: TEST_PICTURE }]);
	});

	it("keeps a table's cells, its first row its header, and a merged cell's words in the first cell it spans", () => {
		expect(deck.slides[4]).toBe(
			lines(
				"<!-- layout: table -->",
				"## Owners",
				[
					"",
					"| Milestone                | Owner |",
					"| ------------------------ | ----- |",
					"| Beta, shared by everyone |       |",
					"| Launch                   | Marco |",
					"",
				].join("\n"),
			),
		);
	});

	it("leaves out a chart, a drawn shape and a picture of a kind a deck can't show, counting them, and keeps a shape's words", () => {
		expect(deck.slides[6]).toBe(
			lines(
				"<!-- layout: bullets -->",
				"## Revenue",
				"Up 60% on last year",
				"<!-- notes: The chart is in the appendix too. -->",
			),
		);
		expect({ imagesLeftOut: deck.imagesLeftOut, othersLeftOut: deck.othersLeftOut }).toEqual({
			imagesLeftOut: 1,
			othersLeftOut: 2,
		});
	});

	it("takes words in quotation marks, over whose they are, for a quote, and a title alone after the first slide for a section break", () => {
		expect(deck.slides[7]).toBe(
			lines(
				"<!-- layout: quote -->",
				"> “Nothing a person writes is lost.”",
				"Priya, at the launch",
			),
		);
		expect(deck.slides[8]).toBe(lines("<!-- layout: section -->", "## Questions?"));
	});

	it("keeps an empty slide, as a new one of the deck's is", () => {
		const empty = deck.deck.child(9);
		expect(layoutOf(empty)).toBe("bullets");
		expect(empty.textContent).toBe("");
	});

	it("fails, with why, when an image it would keep can't be kept", async () => {
		const offline = new Error("offline");

		const importing = deckFromPowerPoint(await powerPointImportTestFile(), schema, () =>
			Promise.reject(offline),
		);

		await expect(importing).rejects.toBeInstanceOf(ImageNotKept);
		await expect(importing).rejects.toHaveProperty("cause", offline);
	});

	it("fails for a file that isn't a PowerPoint file", async () => {
		const notPowerPoint = new TextEncoder().encode("not a PowerPoint file");

		await expect(
			deckFromPowerPoint(new Uint8Array(notPowerPoint).buffer, schema, async () => "/images/1"),
		).rejects.toThrow();
	});
});

describe("importing a deck exported as a PowerPoint file", () => {
	const artifact = {
		podId: "0199a3a0-0000-7000-8000-000000000001",
		id: "0199a3a0-0000-7000-8000-000000000002",
		title: "Launch review",
	};
	const imageIds = artifactImageIds({
		podId: artifact.podId,
		artifactId: artifact.id,
		imageId: "a".repeat(64),
	});
	if (!imageIds) throw new Error("fixture");

	/** A deck with a slide of each layout, as a bot writes one. */
	const DECK = [
		lines(
			"<!-- layout: title -->",
			"# Launch review",
			"Q3, for the whole team",
			"<!-- notes: Welcome everyone.\n\nSay the **new** pod's name. -->",
		),
		lines(
			"<!-- layout: bullets -->",
			"## Goals",
			[
				"- Ship *live* slides",
				"  - with suggestions",
				"- Keep **everything**, ~~nothing~~ lost: x<sup>2</sup>, <u>this</u>",
				"- Read [the plan](https://example.com/plan)",
			].join("\n"),
			"3. Third\n4. Fourth",
		),
		lines(
			"<!-- layout: columns -->",
			"## People and bots",
			"<!-- column -->",
			"### People",
			"- Type in the page",
			"<!-- column -->",
			"### Bots",
			"1. Suggest changes",
		),
		lines(
			"<!-- layout: image -->",
			"## The chart",
			"<!-- column -->",
			"Sales went up.",
			"<!-- column -->",
			`![The launch chart](${artifactImageAddress(imageIds)})`,
		),
		lines("<!-- layout: section -->", "## Where we are", "Part 2"),
		lines("<!-- layout: quote -->", "> Nothing a person writes is lost.", "The team"),
		lines(
			"<!-- layout: table -->",
			"## Owners",
			"| Milestone | Owner |\n| --- | --- |\n| Beta | Priya |\n| Launch | Marco |",
		),
	].join("\n\n---\n\n");

	it("brings back six of its seven layouts, with each slide's title, lists, marks, links, table, image and notes; a quote comes back a section break, a column's heading a bold line and the notes without their marks", async () => {
		const file = await Effect.runPromise(
			powerPointFileOf(artifact, DECK, () =>
				Effect.succeed({ contentType: "image/png" as const, bytes: TEST_PICTURE }),
			),
		);

		const roundTrip = await imported(new Uint8Array(file).buffer);

		const original = slidesInMarkdown(liveDocumentFromMarkdown("slides", DECK));
		expect(roundTrip.deck.children.map(layoutOf)).toEqual([
			"title",
			"bullets",
			"columns",
			"image",
			"section",
			"section",
			"table",
		]);
		const [title, bullets, columns, image, section, quote, table] = roundTrip.slides;
		// The file's notes are their words alone.
		expect(title).toBe(original[0]?.replace("**new**", "new"));
		expect(bullets).toBe(original[1]);
		// A heading in a column is written as a bold line, as no placeholder holds it.
		expect(columns).toBe(original[2]?.replaceAll(/### (\w+)/g, "**$1**"));
		expect(image).toBe(original[3]?.replace(artifactImageAddress(imageIds), "/images/1"));
		expect(section).toBe(original[4]);
		// The quote is written in the slide's title placeholder, without quotation marks.
		expect(quote).toBe(
			lines("<!-- layout: section -->", "## Nothing a person writes is lost.", "The team"),
		);
		expect(table).toBe(original[6]);
		expect(roundTrip.kept).toEqual([{ type: "image/png", bytes: TEST_PICTURE }]);
		expect({ images: roundTrip.imagesLeftOut, others: roundTrip.othersLeftOut }).toEqual({
			images: 0,
			others: 0,
		});
	});
});
