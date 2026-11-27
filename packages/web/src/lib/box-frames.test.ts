import type { Frame } from "@sugabots/contracts/slide-geometry";
import { describe, expect, it } from "vitest";
import {
	type Guide,
	type Handle,
	movedFrame,
	NO_SNAP_LINES,
	resizedFrame,
	type Shift,
	snapLinesAround,
} from "./box-frames.ts";

/*
 * Where a box on a slide goes when a person moves or resizes it by hand, in a
 * slide's pixels: a slide is 960 across and 540 down, a slide of bullets keeps
 * a margin of 80 at either side and 64 at its top and foot, and a person may
 * make a box no smaller than 48 across and 24 down.
 */

/** The lines a box snaps to on a slide of bullets holding one other box, which has its left edge at 600 and its top at 330. */
const LINES = snapLinesAround([{ x: 600, y: 330, width: 200, height: 100 }], "bullets");

/** A box clear of every line it snaps to: its left, centre and right at 200, 350 and 500, and its top, middle and foot at 150, 180 and 210. */
const CLEAR: Frame = { x: 200, y: 150, width: 300, height: 60 };

describe("a box moved by hand", () => {
	it.each<[string, Shift, Pick<Frame, "x" | "y">]>([
		["past the slide's right and foot", { dx: 1000, dy: 1000 }, { x: 660, y: 480 }],
		["past the slide's left and top", { dx: -1000, dy: -1000 }, { x: 0, y: 0 }],
	])("stays on the slide, the same size, when moved %s", (_, shift, at) => {
		expect(movedFrame(CLEAR, shift, NO_SNAP_LINES).frame).toEqual({
			...at,
			width: 300,
			height: 60,
		});
	});

	it.each<[string, Shift, Pick<Frame, "x" | "y">, Guide]>([
		[
			"its left edge, to the slide's side margin",
			{ dx: -116, dy: 0 },
			{ x: 80, y: 150 },
			{ direction: "down", at: 80 },
		],
		[
			"its centre, to the slide's centre line",
			{ dx: 133, dy: 0 },
			{ x: 330, y: 150 },
			{ direction: "down", at: 480 },
		],
		[
			"its top, to the top of another box",
			{ dx: 0, dy: 176 },
			{ x: 200, y: 330 },
			{ direction: "across", at: 330 },
		],
	])("snaps %s from within six pixels of it, showing the line", (_, shift, at, line) => {
		const { frame, guides } = movedFrame(CLEAR, shift, LINES);

		expect(frame).toEqual({ ...at, width: 300, height: 60 });
		expect(guides).toEqual([line]);
	});

	it("snaps to nothing seven pixels or more from it", () => {
		const { frame, guides } = movedFrame(CLEAR, { dx: -110, dy: 0 }, LINES);

		expect(frame).toEqual({ x: 90, y: 150, width: 300, height: 60 });
		expect(guides).toEqual([]);
	});

	it.each<[string, Frame, Shift, Pick<Frame, "x" | "y">]>([
		[
			"past the slide's left, as a picture bleeding off it, moves on, but no further off",
			{ x: -40, y: 100, width: 200, height: 100 },
			{ dx: -20, dy: 0 },
			{ x: -40, y: 100 },
		],
		[
			"wider than the slide moves only as far as keeps it across the slide",
			{ x: -10, y: 0, width: 1000, height: 540 },
			{ dx: -100, dy: 0 },
			{ x: -40, y: 0 },
		],
	])("that sits %s", (_, start, shift, at) => {
		expect(movedFrame(start, shift, NO_SNAP_LINES).frame).toEqual({
			...at,
			width: start.width,
			height: start.height,
		});
	});
});

describe("a box resized by hand", () => {
	const box: Frame = { x: 100, y: 100, width: 200, height: 100 };

	it.each<[Handle, Shift, Frame]>([
		["right", { dx: -500, dy: 0 }, { x: 100, y: 100, width: 48, height: 100 }],
		["bottom", { dx: 0, dy: -500 }, { x: 100, y: 100, width: 200, height: 24 }],
		["top-left", { dx: 500, dy: 500 }, { x: 252, y: 176, width: 48, height: 24 }],
	])("by its %s handle goes no smaller than a person may make a box", (handle, shift, frame) => {
		expect(resizedFrame(box, handle, shift, NO_SNAP_LINES).frame).toEqual(frame);
	});

	it.each<[Handle, Shift, Frame]>([
		["bottom-right", { dx: 5000, dy: 5000 }, { x: 100, y: 100, width: 860, height: 440 }],
		["top-left", { dx: -5000, dy: -5000 }, { x: 0, y: 0, width: 300, height: 200 }],
	])("by its %s handle stays on the slide", (handle, shift, frame) => {
		expect(resizedFrame(box, handle, shift, NO_SNAP_LINES).frame).toEqual(frame);
	});

	it.each<[string, Handle, Shift, Frame]>([
		[
			"grown past the slide's left and top",
			"top-left",
			{ dx: -10, dy: -10 },
			{ x: 0, y: 0, width: 24, height: 24 },
		],
		[
			"shrunk from its left and top",
			"top-left",
			{ dx: 10, dy: 10 },
			{ x: 4, y: 4, width: 20, height: 20 },
		],
		["shrunk from its right", "right", { dx: -10, dy: 0 }, { x: 4, y: 4, width: 20, height: 20 }],
	])(
		"smaller than a person may make one, near the slide's left and top, stays on the slide and no smaller than it is when %s",
		(_, handle, shift, frame) => {
			const small: Frame = { x: 4, y: 4, width: 20, height: 20 };

			expect(resizedFrame(small, handle, shift, NO_SNAP_LINES).frame).toEqual(frame);
		},
	);

	it.each<[string, Handle, Shift, Frame, Guide]>([
		[
			"its right edge, to the slide's centre line",
			"right",
			{ dx: -17, dy: 0 },
			{ ...CLEAR, width: 280 },
			{ direction: "down", at: 480 },
		],
		[
			"its foot, to the top of another box",
			"bottom",
			{ dx: 0, dy: 116 },
			{ ...CLEAR, height: 180 },
			{ direction: "across", at: 330 },
		],
	])("snaps %s from within six pixels of it, showing the line", (_, handle, shift, frame, line) => {
		const { frame: resized, guides } = resizedFrame(CLEAR, handle, shift, LINES);

		expect(resized).toEqual(frame);
		expect(guides).toEqual([line]);
	});

	it("snaps to nothing seven pixels or more from it", () => {
		const { frame, guides } = resizedFrame(CLEAR, "right", { dx: -10, dy: 0 }, LINES);

		expect(frame).toEqual({ ...CLEAR, width: 290 });
		expect(guides).toEqual([]);
	});

	it("past the slide's left, as a picture bleeding off it, keeps its edge there, but no further off", () => {
		const bleeding: Frame = { x: -40, y: 100, width: 200, height: 100 };

		expect(resizedFrame(bleeding, "left", { dx: -20, dy: 0 }, NO_SNAP_LINES).frame).toEqual(
			bleeding,
		);
		expect(resizedFrame(bleeding, "left", { dx: 10, dy: 0 }, NO_SNAP_LINES).frame).toEqual({
			...bleeding,
			x: -30,
			width: 190,
		});
	});
});
