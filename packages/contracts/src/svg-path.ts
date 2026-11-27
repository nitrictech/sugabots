import { NUMBER_PATTERN, within } from "./css-values.ts";
import { SLIDE_REACH } from "./slide-geometry.ts";

/*
 * The outline of a shape on a slide that isn't a plain rectangle, such as an
 * arrow, a chevron or a line: an SVG path in its box's own pixels, from
 * (0, 0) at the box's top left corner to (width, height) at its bottom right.
 */

declare const svgPathParsed: unique symbol;

/**
 * An SVG path's data, as a `d` attribute says it. Only `svgPathIn` and the
 * functions here make one, so it is always path commands and numbers, which
 * draw a shape and nothing else.
 */
export type SvgPath = string & { readonly [svgPathParsed]: true };

/**
 * The numbers each of SVG's path commands takes, by its letter in lower
 * case, as SVG names them: a point is `x` and `y`, `x1`, `y1`, `x2` and `y2`
 * are a curve's control points, and an arc has its radii, the tilt of its
 * ellipse in degrees, and two flags, for the larger of its two arcs and for
 * drawing it clockwise.
 */
export interface PathCommandNumbers {
	m: [x: number, y: number];
	l: [x: number, y: number];
	h: [x: number];
	v: [y: number];
	c: [x1: number, y1: number, x2: number, y2: number, x: number, y: number];
	s: [x2: number, y2: number, x: number, y: number];
	q: [x1: number, y1: number, x: number, y: number];
	t: [x: number, y: number];
	a: [rx: number, ry: number, tilt: number, large: 0 | 1, clockwise: 0 | 1, x: number, y: number];
	z: [];
}

/**
 * One of a path's commands with one group of its numbers. Its letter is in
 * upper case when its points are on the box, and in lower case when they are
 * from the point the path has reached, as SVG writes them.
 */
export type PathCommand = {
	[L in keyof PathCommandNumbers]: {
		readonly letter: L | Uppercase<L>;
		readonly values: Readonly<PathCommandNumbers[L]>;
	};
}[keyof PathCommandNumbers];

/** How many numbers a group of each command's arguments is, by its letter in lower case. */
const ARGUMENT_COUNTS: {
	readonly [L in keyof PathCommandNumbers]: PathCommandNumbers[L]["length"];
} = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

const isCommandLetter = (letter: string): letter is keyof PathCommandNumbers =>
	letter in ARGUMENT_COUNTS;

/** A command as it is read, before its numbers are known to be its own (see `PathCommand`). */
interface ReadCommand {
	letter: string;
	values: number[];
}

/**
 * The commands `path` draws with, in order, each with one group of its
 * numbers as written. A command written with several groups is several of
 * these, each with its letter, and the later groups of a move are the lines
 * they draw, `L`, or `l` after an `m`. The first is always a move, whose
 * point is on the box even when written `m`, as it moves from the box's
 * corner.
 */
export const pathCommandsOf = (path: SvgPath): readonly PathCommand[] =>
	// Each command holds as many numbers as `ARGUMENT_COUNTS` says, which its numbers' type holds it to.
	(commandsOf(path) ?? []) as unknown as readonly PathCommand[];

const NUMBER = new RegExp(NUMBER_PATTERN, "iy");

/**
 * The commands `data` says, as SVG reads a path: `undefined` when it says
 * anything else, or doesn't start where a path starts, with a move. A command
 * letter may be left out before a group of arguments after the first, which
 * repeats the command before it, but for a move, whose later groups draw
 * lines. An arc's two flags are single digits that need nothing between them.
 */
function commandsOf(data: string): ReadCommand[] | undefined {
	const commands: ReadCommand[] = [];
	let at = 0;
	let letter: string | undefined;
	const skipSeparators = () => {
		while (at < data.length && /[\s,]/.test(data.charAt(at))) at++;
	};
	const readNumber = () => {
		skipSeparators();
		NUMBER.lastIndex = at;
		const [number] = NUMBER.exec(data) ?? [];
		if (number === undefined) return undefined;
		at += number.length;
		return Number(number);
	};
	const readFlag = () => {
		skipSeparators();
		const flag = data.charAt(at);
		if (flag !== "0" && flag !== "1") return undefined;
		at++;
		return Number(flag);
	};
	for (skipSeparators(); at < data.length; skipSeparators()) {
		const next = data.charAt(at);
		if (/[a-z]/i.test(next)) {
			if (!isCommandLetter(next.toLowerCase())) return undefined;
			letter = next;
			at++;
		} else if (letter === undefined || letter.toLowerCase() === "z") {
			return undefined;
		}
		const lower = letter.toLowerCase();
		const count = isCommandLetter(lower) ? ARGUMENT_COUNTS[lower] : 0;
		const values: number[] = [];
		for (let index = 0; index < count; index++) {
			const isFlag = lower === "a" && (index === 3 || index === 4);
			const value = isFlag ? readFlag() : readNumber();
			if (value === undefined || !Number.isFinite(value)) return undefined;
			values.push(value);
		}
		commands.push({ letter, values });
		if (lower === "m") letter = letter === "m" ? "l" : "L";
	}
	return commands[0]?.letter.toLowerCase() === "m" ? commands : undefined;
}

/**
 * `value` as an SVG path, trimmed, or `null` when it is no path's data. Its
 * numbers are kept within `SLIDE_REACH` and an arc's tilt within a turn: a
 * path saying more is written again with those cut there, and its other
 * numbers as they were, so a path within them is the string it was.
 */
export function svgPathIn(value: unknown): SvgPath | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const commands = commandsOf(trimmed);
	if (!commands) return null;
	const bounded = commands.map(withinReach);
	const changed = bounded.some((command, index) =>
		command.values.some((number, at) => number !== commands[index]?.values[at]),
	);
	return changed ? exactPath(bounded) : (trimmed as SvgPath);
}

/** Where an arc's tilt is among its numbers, and its two flags. */
const ARC_TILT = 2;
const ARC_FLAGS = [3, 4];

/** `command` with each of its numbers within `SLIDE_REACH`, but an arc's flags, and its tilt within a turn. */
function withinReach(command: ReadCommand): ReadCommand {
	const arc = command.letter.toLowerCase() === "a";
	const values = command.values.map((value, at) => {
		if (arc && ARC_FLAGS.includes(at)) return value;
		if (arc && at === ARC_TILT) return Math.abs(value) <= 360 ? value : value % 360;
		return within(value, -SLIDE_REACH, SLIDE_REACH);
	});
	return { letter: command.letter, values };
}

/**
 * The paths `paths` say, one after another, as one path, as a drawing of
 * several shapes draws them: `null` for none. Each starts with its own move,
 * on the box, even one written from the point before, `m`, which moves from
 * the box's corner on its own but from the end of the shape before when
 * joined after it.
 */
export function joinedPaths(paths: readonly SvgPath[]): SvgPath | null {
	const joined = paths.map((path) => {
		const [first, ...rest] = commandsOf(path) ?? [];
		return first?.letter === "m" ? exactPath([{ ...first, letter: "M" }, ...rest]) : path;
	});
	return svgPathIn(joined.join(" "));
}

/** A change of where a path's points are: each point (x, y) goes to (x × scaleX + moveX, y × scaleY + moveY). */
export interface PathChange {
	scaleX: number;
	scaleY: number;
	moveX: number;
	moveY: number;
}

/**
 * `path` with its points changed as `change` says. A box resized from its
 * frame's old width and height to new ones keeps its shape across it with
 * `scaleX` and `scaleY` the new over the old, moving nothing, as the path is
 * in the box's own pixels. An arc's radii scale with it, but its tilt
 * doesn't, so an arc tilted in a box scaled more one way than the other is
 * drawn a little off. Numbers are written to a hundredth of a pixel.
 */
export function changedPath(path: SvgPath, { scaleX, scaleY, moveX, moveY }: PathChange): SvgPath {
	const commands = commandsOf(path) ?? [];
	const changed = commands.map((command, index) => {
		// The first move's point is on the box, even when written as one from the point before.
		const letter = index === 0 ? command.letter.toUpperCase() : command.letter;
		const onBox = letter === letter.toUpperCase();
		const x = (value: number) => value * scaleX + (onBox ? moveX : 0);
		const y = (value: number) => value * scaleY + (onBox ? moveY : 0);
		const values = command.values;
		switch (letter.toLowerCase()) {
			case "h":
				return { letter, values: values.map(x) };
			case "v":
				return { letter, values: values.map(y) };
			case "a": {
				const [rx = 0, ry = 0, tilt = 0, large = 0, sweep = 0, endX = 0, endY = 0] = values;
				const mirrored = scaleX * scaleY < 0;
				return {
					letter,
					values: [
						rx * Math.abs(scaleX),
						ry * Math.abs(scaleY),
						tilt,
						large,
						mirrored ? 1 - sweep : sweep,
						x(endX),
						y(endY),
					],
				};
			}
			default:
				return {
					letter,
					values: values.map((value, at) => (at % 2 === 0 ? x(value) : y(value))),
				};
		}
	});
	return writtenPath(changed.map(withinReach));
}

/** `commands` as a path, each number to a hundredth of a pixel, as a path changed by scaling is written. */
const writtenPath = (commands: readonly ReadCommand[]): SvgPath =>
	commands
		.map(({ letter, values }) =>
			[letter, ...values.map((value) => String(Number(value.toFixed(2))))].join(" "),
		)
		.join(" ") as SvgPath;

/** `commands` as a path, each number as it was read. */
const exactPath = (commands: readonly ReadCommand[]): SvgPath =>
	commands
		.map(({ letter, values }) => [letter, ...values.map(String)].join(" "))
		.join(" ") as SvgPath;

/** An element of an SVG drawing, as far as reading the shape it draws goes. */
export interface ShapeElement {
	readonly localName: string;
	getAttribute(name: string): string | null;
}

/**
 * The outline of the shape `element` draws, as a path, when it is one of
 * SVG's shapes: a path, a polygon or polyline, a line, a rectangle, a circle
 * or an ellipse. A rectangle's rounded corners are left out. `null` for any
 * other element, or a shape whose numbers don't say one.
 */
export function pathOfShape(element: ShapeElement): SvgPath | null {
	const number = (name: string) => Number(element.getAttribute(name) ?? 0);
	switch (element.localName.toLowerCase()) {
		case "path":
			return svgPathIn(element.getAttribute("d"));
		case "polygon":
		case "polyline": {
			const [first, ...rest] = pointsIn(element.getAttribute("points") ?? "");
			if (!first) return null;
			const lines = rest.map(([x, y]) => `L ${x} ${y}`);
			const close = element.localName.toLowerCase() === "polygon" ? ["Z"] : [];
			return svgPathIn([`M ${first[0]} ${first[1]}`, ...lines, ...close].join(" "));
		}
		case "line":
			return svgPathIn(`M ${number("x1")} ${number("y1")} L ${number("x2")} ${number("y2")}`);
		case "rect": {
			const [x, y, width, height] = [number("x"), number("y"), number("width"), number("height")];
			return svgPathIn(`M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`);
		}
		case "circle":
		case "ellipse": {
			const [cx, cy] = [number("cx"), number("cy")];
			const circle = element.localName.toLowerCase() === "circle";
			const [rx, ry] = circle ? [number("r"), number("r")] : [number("rx"), number("ry")];
			const half = `A ${rx} ${ry} 0 1 0`;
			return svgPathIn(`M ${cx - rx} ${cy} ${half} ${cx + rx} ${cy} ${half} ${cx - rx} ${cy} Z`);
		}
		default:
			return null;
	}
}

/** The points a polygon's `points` says, in pairs. */
function pointsIn(points: string): [number, number][] {
	const numbers = points
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const pairs: [number, number][] = [];
	for (let at = 0; at + 1 < numbers.length; at += 2) {
		pairs.push([numbers[at] ?? 0, numbers[at + 1] ?? 0]);
	}
	return pairs;
}
