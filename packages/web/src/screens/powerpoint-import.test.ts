import { liveDocumentSchema, markdownOfDocument } from "@sugabots/contracts/live-document-text";
import { backgroundOf, bodyOf, boxAttributesOf, layoutOf } from "@sugabots/contracts/live-slides";
import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import type { JSONContent } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ImageNotKept, type KeepableImage } from "@/lib/file-import.ts";
import { deckFromPowerPoint } from "@/lib/powerpoint-import.ts";
import {
	powerPointImportTestFile,
	TEST_LINK,
	TEST_PICTURE,
} from "./powerpoint-import-test-file.ts";

/*
 * What a PowerPoint file's import keeps: each slide as the file draws it, a
 * box for each thing on it, where the file puts it, with its words, lists,
 * tables, pictures and shapes, and its notes, and what it counts as left out.
 * A box's words are read back as a document's markdown, their styles apart.
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
	return { ...result, kept };
}

/** The boxes on the slide at `index` of `deck`. */
const boxesOn = (deck: Node, index: number) => bodyOf(deck.child(index)).children;

/** `content` without the text styles a document has no place for. */
function withoutTextStyles(content: JSONContent): JSONContent {
	return {
		...content,
		marks: content.marks?.filter((mark) => mark.type !== TEXT_STYLE),
		content: content.content?.map(withoutTextStyles),
	};
}

/** What `holder`, a box or a slide's notes, holds, as a document's markdown. */
const markdownOf = (holder: Node) =>
	markdownOfDocument(
		liveDocumentSchema("document").nodeFromJSON(
			withoutTextStyles({ type: "doc", content: holder.toJSON().content }),
		),
	);

/** How the text of the first line of `box` looks. */
const textStyleOf = (box: Node) =>
	box.firstChild?.firstChild?.marks.find((mark) => mark.type.name === TEXT_STYLE)?.attrs;

describe("importing a PowerPoint file", () => {
	let deck: Awaited<ReturnType<typeof imported>>;
	beforeAll(async () => {
		deck = await imported(await powerPointImportTestFile());
	});

	it("makes a slide of each of the file's, in order, each of no layout, on the file's colour", () => {
		expect(deck.deck.childCount).toBe(10);
		for (const slide of deck.deck.children) {
			expect(layoutOf(slide)).toBe("blank");
			expect(backgroundOf(slide)).toBe("#FFFFFF");
		}
	});

	it("keeps each text box where the file puts it, its words in their colour, size, font and alignment, and the notes a paragraph a line", () => {
		const [title, subtitle] = boxesOn(deck.deck, 0);
		if (!title || !subtitle) throw new Error("The title slide lost a box");

		expect(boxAttributesOf(title)).toEqual({
			role: null,
			frame: { x: 72, y: 172.8, width: 813.6, height: 86.4 },
			fill: null,
			stroke: null,
			path: null,
			verticalAlign: "middle",
			padding: { top: 3.6, right: 7.2, bottom: 3.6, left: 7.2 },
			rotation: 0,
		});
		expect(markdownOf(title)).toBe("**Quarterly review**");
		expect(textStyleOf(title)).toEqual({
			color: "#000000",
			fontSize: 44,
			fontFamily: '"Calibri", sans-serif',
		});
		expect(title.firstChild?.attrs).toMatchObject({ textAlign: "center", lineHeight: 1.2 });
		expect(markdownOf(subtitle)).toBe("Q3, for the whole team");
		expect(markdownOf(deck.deck.child(0).child(1))).toBe(
			"Welcome everyone.\n\nSay the new pod's name.",
		);
	});

	it("keeps bullets and numbers at their levels, with bold, italics, underline, strikethrough, superscript, subscript and links, and leaves out the slide's number", () => {
		const boxes = boxesOn(deck.deck, 1);
		expect(boxes.map(markdownOf)).toEqual([
			"**Goals**",
			[
				[
					"- Ship *live* slides",
					"  - with suggestions",
					"  - and notes",
					`- Keep **everything**, see [the plan](${TEST_LINK})`,
					"- x<sup>2</sup> and H<sub>2</sub>O, <u>underlined</u> and ~~struck~~",
				].join("\n"),
				"1. Write it\n2. Ship it",
			].join("\n\n"),
		]);
		expect(markdownOf(deck.deck.child(1).child(1))).toBe("Keep this one short.");
	});

	it("keeps a picture, with its words, as the image of a box where the file puts it, keeping the same picture once", () => {
		const [, words, picture] = boxesOn(deck.deck, 3);
		if (!words || !picture) throw new Error("The picture's slide lost a box");

		expect(markdownOf(words)).toBe("Every region grew, the north most of all.");
		expect(boxAttributesOf(picture)).toMatchObject({
			role: "image",
			frame: { x: 496.8, y: 108, width: 417.6, height: 374.4 },
			padding: null,
		});
		expect(markdownOf(picture)).toBe("![The sales chart](/images/1)");
		expect(boxesOn(deck.deck, 5).map(markdownOf)).toEqual(["![](/images/1)"]);
		expect(deck.kept).toEqual([{ type: "image/png", bytes: TEST_PICTURE }]);
	});

	it("keeps a table's cells, its first row its header in the deck's own colours, a merged cell's words in the first cell it spans, and its columns' widths", () => {
		const [, table] = boxesOn(deck.deck, 4);
		if (!table) throw new Error("The table's slide lost its table");

		expect(markdownOf(table)).toBe(
			[
				"",
				"| Milestone                | Owner |",
				"| ------------------------ | ----- |",
				"| Beta, shared by everyone |       |",
				"| Launch                   | Marco |",
				"",
			].join("\n"),
		);
		const [header, , launch] = table.firstChild?.children ?? [];
		expect(textStyleOf(header?.child(0) ?? table)).toEqual({
			color: null,
			fontSize: 16,
			fontFamily: '"Calibri", sans-serif',
		});
		expect(textStyleOf(launch?.child(0) ?? table)).toMatchObject({ color: "#000000" });
		expect(table.firstChild?.firstChild?.children.map((cell) => cell.attrs.colwidth?.[0])).toEqual([
			436, 436,
		]);
	});

	it("keeps shapes with their outline and fill, and leaves out a chart and a picture of a kind a deck can't show, counting them", () => {
		const boxes = boxesOn(deck.deck, 6);
		expect(boxes.map(markdownOf)).toEqual(["**Revenue**", "", "Up 60% on last year"]);
		const [, square, ellipse] = boxes.map(boxAttributesOf);
		expect(square).toMatchObject({ fill: "#2563EB", path: null });
		expect(ellipse).toMatchObject({ fill: "#FDE68A", verticalAlign: "middle" });
		expect(ellipse?.path).toMatch(/^M 0 54 A 144 54 /);
		expect(markdownOf(deck.deck.child(6).child(1))).toBe("The chart is in the appendix too.");
		expect({ imagesLeftOut: deck.imagesLeftOut, othersLeftOut: deck.othersLeftOut }).toEqual({
			imagesLeftOut: 1,
			othersLeftOut: 1,
		});
	});

	it("keeps an empty slide, holding no boxes", () => {
		const empty = deck.deck.child(9);
		expect(bodyOf(empty).childCount).toBe(0);
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
