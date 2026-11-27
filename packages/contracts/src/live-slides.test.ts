import type { Node } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { cssColorIn } from "./css-values.ts";
import { DECK_SCHEMA } from "./deck-html.ts";
import { bodyOf, boxAttributesOf, laidOutAnew, newSlide, resetToTemplate } from "./live-slides.ts";
import type { BoxAttributes, BoxRole } from "./slide-box.ts";
import { type SlideLayout, templateBoxOf } from "./slide-layouts.ts";
import { svgPathIn } from "./svg-path.ts";

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
});
