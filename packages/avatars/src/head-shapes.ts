import type { AgentShape } from "@sugabots/contracts";
import { FACE_VIEWBOX_SIZE } from "./face-marks.ts";

/** One filled piece of a head: an outline, or a disc such as an ear or a petal. */
export type HeadPart =
	| { kind: "path"; d: string }
	| { kind: "circle"; cx: number; cy: number; r: number };

/**
 * Where a head's eyes go: the centre of the pair, and their size against the
 * full-size face they're drawn for. A head with ears or an antenna is smaller
 * than the square it's drawn in, so its eyes sit lower and smaller.
 */
export interface EyePlacement {
	x: number;
	y: number;
	scale: number;
}

/** A head's outline, in pieces filled in the bot's colour, and where its eyes sit. */
export interface HeadShape {
	parts: readonly HeadPart[];
	eyes: EyePlacement;
}

type Point = readonly [number, number];

const CENTRE = FACE_VIEWBOX_SIZE / 2;
const centred: EyePlacement = { x: CENTRE, y: CENTRE, scale: 1 };

const round = (value: number) => Math.round(value * 100) / 100;

/** The corners of a regular polygon, the first straight up from `centre` unless `turn` (degrees) says otherwise. */
function regularPolygon(sides: number, radius: number, centre: Point, turn = 0): Point[] {
	return Array.from({ length: sides }, (_, index) => {
		const angle = ((turn - 90 + (360 / sides) * index) * Math.PI) / 180;
		return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)] as const;
	});
}

/** A star's points and the dips between them, alternating, the first point straight up. */
function starPoints(points: number, outer: number, inner: number, centre: Point): Point[] {
	return Array.from({ length: points * 2 }, (_, index) => {
		const radius = index % 2 === 0 ? outer : inner;
		const angle = ((-90 + (180 / points) * index) * Math.PI) / 180;
		return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)] as const;
	});
}

/** A closed outline through `corners`, each rounded off `radius` along its two sides. */
function roundedPolygon(corners: readonly Point[], radius: number): string {
	const along = (from: Point, to: Point, distance: number): Point => {
		const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
		const share = Math.min(distance, length / 2) / length;
		return [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share];
	};
	const point = ([x, y]: Point) => `${round(x)} ${round(y)}`;
	const turns = corners.map((corner, index) => {
		const before = corners[(index + corners.length - 1) % corners.length] ?? corner;
		const after = corners[(index + 1) % corners.length] ?? corner;
		return { corner, into: along(corner, before, radius), out: along(corner, after, radius) };
	});
	const [first, ...rest] = turns;
	if (!first) return "";
	return [
		`M${point(first.into)}Q${point(first.corner)} ${point(first.out)}`,
		...rest.map(({ corner, into, out }) => `L${point(into)}Q${point(corner)} ${point(out)}`),
		"Z",
	].join("");
}

const outline = (d: string): HeadPart => ({ kind: "path", d });
const disc = (cx: number, cy: number, r: number): HeadPart => ({ kind: "circle", cx, cy, r });

/** Discs of `radius` evenly round `centre` at `distance`, the first straight up. */
function ring(count: number, distance: number, radius: number): HeadPart[] {
	return regularPolygon(count, distance, [CENTRE, CENTRE]).map(([cx, cy]) =>
		disc(round(cx), round(cy), radius),
	);
}

/*
 * Every head fills the 40-unit square a face is drawn in, as a circle does,
 * so swapping one shape for another keeps a bot the same size.
 */
const headShapes: Record<AgentShape, HeadShape> = {
	circle: { parts: [disc(CENTRE, CENTRE, CENTRE)], eyes: centred },
	squircle: {
		parts: [outline("M20 1C34.5 1 39 5.5 39 20S34.5 39 20 39 1 34.5 1 20 5.5 1 20 1Z")],
		eyes: centred,
	},
	pebble: {
		parts: [outline("M21 3.5C32.5 3.5 39 10 39 20.5S32 37 20 37 1 31 1 21 9 3.5 21 3.5Z")],
		eyes: { x: 20, y: 20.5, scale: 0.95 },
	},
	blob: {
		parts: [
			outline(
				"M24.5 2.5C34.5 3.5 39.5 12 37.5 23S27.5 39.5 17 37.5.5 28 2.5 18 14.5 1.5 24.5 2.5Z",
			),
		],
		eyes: { x: 20, y: 20.5, scale: 0.95 },
	},
	wobble: {
		parts: [
			outline("M28 2C36 2.5 39.5 9.5 37.5 19.5S29.5 38 18.5 38 1.5 31.5 2.5 22.5 16.5 1.5 28 2Z"),
		],
		eyes: { x: 20, y: 21, scale: 0.95 },
	},
	drop: {
		parts: [outline("M20 2C30 2 38 10 38 20S30 38 20 38H7C4.2 38 2 35.8 2 33V20C2 10 10 2 20 2Z")],
		eyes: centred,
	},
	leaf: {
		parts: [
			outline(
				"M7 2H22C31 2 38 9 38 18V33C38 35.8 35.8 38 33 38H18C9 38 2 31 2 22V7C2 4.2 4.2 2 7 2Z",
			),
		],
		eyes: centred,
	},
	dome: {
		parts: [
			outline("M2 21C2 11 10 3 20 3S38 11 38 21V33C38 35.8 35.8 38 33 38H7C4.2 38 2 35.8 2 33Z"),
		],
		eyes: { x: 20, y: 22, scale: 1 },
	},
	bowl: {
		parts: [
			outline("M7 3H33C35.8 3 38 5.2 38 8V19C38 29.5 30 38 20 38S2 29.5 2 19V8C2 5.2 4.2 3 7 3Z"),
		],
		eyes: { x: 20, y: 19, scale: 1 },
	},
	hexagon: {
		parts: [outline(roundedPolygon(regularPolygon(6, 19.5, [CENTRE, CENTRE], 30), 4))],
		eyes: { x: 20, y: 20, scale: 0.9 },
	},
	octagon: {
		parts: [outline(roundedPolygon(regularPolygon(8, 20.5, [CENTRE, CENTRE], 22.5), 3.5))],
		eyes: { x: 20, y: 20, scale: 0.95 },
	},
	triangle: {
		parts: [
			outline(
				roundedPolygon(
					[
						[20, 1.5],
						[39.5, 36],
						[0.5, 36],
					],
					9.5,
				),
			),
		],
		eyes: { x: 20, y: 24.5, scale: 0.8 },
	},
	pentagon: {
		parts: [outline(roundedPolygon(regularPolygon(5, 20.5, [CENTRE, 21.5]), 4.5))],
		eyes: { x: 20, y: 22.5, scale: 0.85 },
	},
	diamond: {
		parts: [
			outline(
				roundedPolygon(
					[
						[20, 0.5],
						[39.5, 20],
						[20, 39.5],
						[0.5, 20],
					],
					6,
				),
			),
		],
		eyes: { x: 20, y: 20, scale: 0.8 },
	},
	shield: {
		parts: [
			outline(
				roundedPolygon(
					[
						[3, 3],
						[37, 3],
						[37, 21],
						[20, 38],
						[3, 21],
					],
					5,
				),
			),
		],
		eyes: { x: 20, y: 17, scale: 0.9 },
	},
	star: {
		parts: [outline(roundedPolygon(starPoints(5, 21.5, 13, [CENTRE, 21.5]), 4))],
		eyes: { x: 20, y: 22, scale: 0.75 },
	},
	flower: {
		parts: [...ring(4, 9.5, 10.5), disc(CENTRE, CENTRE, 12)],
		eyes: { x: 20, y: 20, scale: 0.9 },
	},
	scallop: {
		parts: [...ring(8, 13, 7), disc(CENTRE, CENTRE, 14)],
		eyes: { x: 20, y: 20, scale: 0.85 },
	},
	ghost: {
		parts: [
			outline(
				"M4 18C4 9.2 11.2 2 20 2S36 9.2 36 18V34a5.33 5.33 0 0 1-10.67 0a5.33 5.33 0 0 1-10.66 0a5.33 5.33 0 0 1-10.67 0Z",
			),
		],
		eyes: { x: 20, y: 17, scale: 0.9 },
	},
	bear: {
		parts: [disc(8, 9, 6.5), disc(32, 9, 6.5), disc(20, 23, 16)],
		eyes: { x: 20, y: 23.5, scale: 0.8 },
	},
	antenna: {
		parts: [disc(20, 5, 3.8), outline("M18.8 7h2.4v5h-2.4Z"), disc(20, 25, 15)],
		eyes: { x: 20, y: 25.5, scale: 0.75 },
	},
};

/** How a head shape is drawn: its pieces and where its eyes go. */
export function headShape(shape: AgentShape): HeadShape {
	return headShapes[shape];
}
