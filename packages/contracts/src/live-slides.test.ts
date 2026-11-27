import type { Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";
import { cssColorIn } from "./css-values.ts";
import { DECK_SCHEMA } from "./deck-html.ts";
import {
	bodyOf,
	boxAttributesOf,
	FIRST_BOX_IN_SLIDE,
	laidOutAnew,
	newSlide,
	resetToTemplate,
	setBoxAttributes,
} from "./live-slides.ts";
import type { BoxAttributes, BoxRole } from "./slide-box.ts";
import type { Frame } from "./slide-geometry.ts";
import { type SlideLayout, templateBoxOf } from "./slide-layouts.ts";
import { svgPathIn } from "./svg-path.ts";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

const heading = (text: string) => ({
	type: "heading",
	attrs: { level: 2 },
	content: [{ type: "text", text }],
});

const bullet = (text: string) => ({
	type: "bulletList",
	content: [
		{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
	],
});

const box = (attrs: Partial<BoxAttributes>, ...blocks: object[]) => ({
	type: "slideBox",
	attrs,
	content: blocks.length > 0 ? blocks : [{ type: "paragraph" }],
});

function slideOf(layout: SlideLayout, ...boxes: object[]): Node {
	return DECK_SCHEMA.nodeFromJSON({
		type: "slide",
		attrs: { layout },
		content: [
			{ type: "slideBody", content: boxes },
			{ type: "speakerNotes", content: [{ type: "paragraph" }] },
		],
	});
}

const templateFrame = (layout: SlideLayout, role: BoxRole) => templateBoxOf(layout, role)?.frame;

/** What each of `slide`'s boxes is for, where it is, and the words it holds. */
const boxesOf = (slide: Node) =>
	bodyOf(slide).children.map((each) => ({
		role: boxAttributesOf(each).role,
		frame: boxAttributesOf(each).frame,
		text: each.textContent,
	}));

/** A title moved by hand, off where any layout puts one. */
const MOVED_TITLE = box(
	{ role: "title", frame: { x: 24, y: 24, width: 400, height: 60 } },
	heading("Plan"),
);

const BODY = box(
	{ role: "body", frame: { x: 80, y: 144, width: 800, height: 332 } },
	bullet("One"),
);

/** A frame no layout puts a box at. */
const MOVED_FRAME = { x: 24, y: 24, width: 400, height: 60 };

/** A title drawn as a rectangle filling its frame, as a file's title may be. */
const TITLE_SHAPE = box({
	role: "title",
	frame: MOVED_FRAME,
	path: svgPathIn("M 0 0 L 400 0 L 400 60 L 0 60 Z"),
});

/** A shape with no role, as a slide imported from a file holds. */
const ARROW = box({
	frame: { x: 700, y: 380, width: 160, height: 80 },
	fill: cssColorIn("#f59e0b"),
	path: svgPathIn("M 0 0 L 160 40 L 0 80 Z"),
});

describe("laidOutAnew", () => {
	it("moves a title to where the new layout puts one, holding what it held", () => {
		const [title] = bodyOf(laidOutAnew(slideOf("bullets", MOVED_TITLE, BODY), "title")).children;
		expect(title && boxAttributesOf(title).frame).toEqual(templateFrame("title", "title"));
		expect(title?.textContent).toBe("Plan");
	});

	it("moves a box of a role the new layout lacks to the role it has left, adding the rest", () => {
		const laidOut = laidOutAnew(slideOf("bullets", MOVED_TITLE, BODY), "columns");
		expect(boxesOf(laidOut)).toEqual([
			{ role: "title", frame: templateFrame("columns", "title"), text: "Plan" },
			{ role: "leftColumn", frame: templateFrame("columns", "leftColumn"), text: "One" },
			{ role: "rightColumn", frame: templateFrame("columns", "rightColumn"), text: "" },
		]);
	});

	it("leaves a box with no role as it is, where it is among the boxes", () => {
		const slide = slideOf("bullets", MOVED_TITLE, ARROW, BODY);
		const laidOut = laidOutAnew(slide, "section");
		expect(bodyOf(laidOut).child(1)).toBe(bodyOf(slide).child(1));
	});

	it("gives a section break's title only its heading on leaving it, and its label to the role left", () => {
		const label = box({ role: "label", frame: MOVED_FRAME }, paragraph("Part 2"));
		const title = box({ role: "title", frame: MOVED_FRAME }, heading("S"), paragraph("under"));
		expect(boxesOf(laidOutAnew(slideOf("section", label, title), "bullets"))).toEqual([
			{ role: "body", frame: templateFrame("bullets", "body"), text: "Part 2under" },
			{ role: "title", frame: templateFrame("bullets", "title"), text: "S" },
		]);
	});

	it("drops a label holding nothing, and adds the roles nothing took", () => {
		const label = box({ role: "label", frame: MOVED_FRAME });
		const title = box({ role: "title", frame: MOVED_FRAME }, heading("S"));
		expect(boxesOf(laidOutAnew(slideOf("section", label, title), "bullets"))).toEqual([
			{ role: "title", frame: templateFrame("bullets", "title"), text: "S" },
			{ role: "body", frame: templateFrame("bullets", "body"), text: "" },
		]);
	});

	it("joins the boxes past the roles left, an empty one keeping its turn", () => {
		const left = box({ role: "leftColumn", frame: MOVED_FRAME });
		const right = box({ role: "rightColumn", frame: MOVED_FRAME }, paragraph("R"));
		expect(boxesOf(laidOutAnew(slideOf("columns", MOVED_TITLE, left, right), "bullets"))).toEqual([
			{ role: "title", frame: templateFrame("bullets", "title"), text: "Plan" },
			{ role: "body", frame: templateFrame("bullets", "body"), text: "R" },
		]);
	});

	it("leaves every box where it is for a layout that places none", () => {
		const slide = slideOf("bullets", MOVED_TITLE, BODY);
		expect(bodyOf(laidOutAnew(slide, "blank")).children).toEqual(bodyOf(slide).children);
	});

	it("stretches a shape's outline to the frame it moves to", () => {
		const laidOut = laidOutAnew(slideOf("bullets", TITLE_SHAPE), "title");
		expect(boxAttributesOf(bodyOf(laidOut).child(0)).path).toBe(
			"M 0 0 L 800 0 L 800 176 L 0 176 Z",
		);
	});
});

describe("resetToTemplate", () => {
	it("puts a moved box back where its layout's template puts it, leaving a box with no role", () => {
		const slide = slideOf("bullets", MOVED_TITLE, ARROW, BODY);
		const reset = resetToTemplate(slide);
		expect(boxesOf(reset)[0]?.frame).toEqual(templateFrame("bullets", "title"));
		expect(bodyOf(reset).child(1)).toBe(bodyOf(slide).child(1));
	});

	it("is the slide itself when its boxes are where its template puts them", () => {
		const slide = newSlide(DECK_SCHEMA, "image");
		expect(resetToTemplate(slide)).toBe(slide);
	});

	it("stretches a shape's outline to the frame it goes back to", () => {
		const reset = resetToTemplate(slideOf("bullets", TITLE_SHAPE));
		expect(boxAttributesOf(bodyOf(reset).child(0))).toMatchObject({
			frame: templateFrame("bullets", "title"),
			path: "M 0 0 L 800 0 L 800 48 L 0 48 Z",
		});
	});

	it("puts back only the first box of a role, leaving a second where it is", () => {
		const second = box({ role: "title", frame: { x: 80, y: 300, width: 400, height: 60 } });
		const slide = slideOf("bullets", MOVED_TITLE, second);
		const reset = resetToTemplate(slide);
		expect(boxesOf(reset)[0]?.frame).toEqual(templateFrame("bullets", "title"));
		expect(bodyOf(reset).child(1)).toBe(bodyOf(slide).child(1));
	});
});

describe("setBoxAttributes", () => {
	/** How `shape`, a box alone on a slide, is drawn once it is given `frame` alone. */
	function boxFramed(shape: object, frame: Frame) {
		const deck = DECK_SCHEMA.nodeFromJSON({
			type: "doc",
			content: [slideOf("blank", shape).toJSON()],
		});
		const change = setBoxAttributes(new Transform(deck), FIRST_BOX_IN_SLIDE, { frame });
		return boxAttributesOf(bodyOf(change.doc.child(0)).child(0));
	}

	it("stretches a shape's outline to a frame given without one", () => {
		const resized = boxFramed(ARROW, { x: 0, y: 0, width: 320, height: 40 });
		expect(resized.path).toBe("M 0 0 L 320 20 L 0 40 Z");
	});

	it("keeps a side of nothing as it is, as a line's height is", () => {
		const line = box({
			frame: { x: 0, y: 0, width: 400, height: 0 },
			path: svgPathIn("M 0 0 L 400 0"),
		});
		expect(boxFramed(line, { x: 0, y: 0, width: 200, height: 30 }).path).toBe("M 0 0 L 200 0");
	});
});
