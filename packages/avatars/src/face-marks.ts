import type { AgentFace } from "@sugabots/contracts";

/** The side of the square a face is drawn in, in SVG user units. */
export const FACE_VIEWBOX_SIZE = 40;

/** One mark drawn on the face disc: an eye, or both eyes as one stroked path. */
export type FaceMark =
	| { shape: "circle"; cx: number; cy: number; r: number }
	| { shape: "rect"; x: number; y: number; width: number; height: number; rx: number }
	| { shape: "stroke"; d: string; strokeWidth: number };

const bars = (rx: number): readonly FaceMark[] => [
	{ shape: "rect", x: 10, y: 15, width: 7, height: 11, rx },
	{ shape: "rect", x: 23, y: 15, width: 7, height: 11, rx },
];

const marksByFace: Record<AgentFace, readonly FaceMark[]> = {
	bar: bars(3.5),
	square: bars(1.5),
	dots: [
		{ shape: "circle", cx: 14, cy: 20, r: 3.8 },
		{ shape: "circle", cx: 26, cy: 20, r: 3.8 },
	],
	smile: [
		{
			shape: "stroke",
			d: "M10.5 21.5a3.5 3.5 0 0 1 7 0M22.5 21.5a3.5 3.5 0 0 1 7 0",
			strokeWidth: 2.6,
		},
	],
};

/** The marks that make up a face, on a disc filling the viewbox. */
export function faceMarks(face: AgentFace): readonly FaceMark[] {
	return marksByFace[face];
}
