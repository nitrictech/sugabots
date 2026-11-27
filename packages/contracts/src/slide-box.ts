import { type CssColor, cssColorIn } from "./css-values.ts";
import { DEFAULT_BOX_FRAME, type Frame, frameIn } from "./slide-geometry.ts";
import { type SvgPath, svgPathIn } from "./svg-path.ts";

/*
 * A box on a slide, the one kind of thing a slide holds: text, a table, an
 * image or a shape, at its frame, drawn over the boxes before it. What it
 * holds is blocks, as a document's are; how it is drawn is its attributes,
 * typed here (`BoxAttributes`). The schema reads and writes them as HTML
 * (see `SlideBox` in `live-slides.ts`).
 */

/**
 * What a box is for, which sets how the slide styles draw what it holds,
 * what it says while empty, and where a layout puts it (see
 * `SLIDE_TEMPLATES`). A box for nothing in particular, as most of a slide
 * imported from a file, has none.
 */
export const BOX_ROLES = [
	"title",
	"subtitle",
	"body",
	"leftColumn",
	"rightColumn",
	"text",
	"image",
	"label",
	"quote",
	"attribution",
	"table",
] as const;
export type BoxRole = (typeof BOX_ROLES)[number];

/** `value` as a box's role, or `null` when it is none this version knows. */
export const boxRoleIn = (value: unknown): BoxRole | null =>
	(BOX_ROLES as readonly unknown[]).includes(value) ? (value as BoxRole) : null;

/** Where what a box holds sits in its frame, from its top down, when it takes less than the frame's height. */
export const VERTICAL_ALIGNMENTS = ["top", "middle", "bottom"] as const;
export type VerticalAlign = (typeof VERTICAL_ALIGNMENTS)[number];

/** `value` as a box's vertical alignment, or the top when it is none. */
export const verticalAlignIn = (value: unknown): VerticalAlign =>
	(VERTICAL_ALIGNMENTS as readonly unknown[]).includes(value) ? (value as VerticalAlign) : "top";

/** A box's outline: its colour, and how thick it is, in a slide's pixels. */
export interface Stroke {
	readonly color: CssColor;
	readonly width: number;
}

/** `value` as a stroke, or `null` unless it has a colour and a finite width above 0. */
export function strokeIn(value: unknown): Stroke | null {
	if (typeof value !== "object" || value === null) return null;
	const { color, width } = value as Partial<Record<keyof Stroke, unknown>>;
	const strokeColor = cssColorIn(color);
	if (!strokeColor || typeof width !== "number" || !(width > 0) || !Number.isFinite(width)) {
		return null;
	}
	return { color: strokeColor, width };
}

/** The room inside a box's frame around what it holds, at each side, in a slide's pixels. */
export interface BoxPadding {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

/** A box's padding when it says none: nothing, as the layouts' frames are drawn for what is in them to fill. */
export const DEFAULT_BOX_PADDING: BoxPadding = Object.freeze({
	top: 0,
	right: 0,
	bottom: 0,
	left: 0,
});

/** `value` as a box's padding, or `null` unless each side is a finite number not below 0. */
export function paddingIn(value: unknown): BoxPadding | null {
	if (typeof value !== "object" || value === null) return null;
	const { top, right, bottom, left } = value as Partial<Record<keyof BoxPadding, unknown>>;
	if (!isSide(top) || !isSide(right) || !isSide(bottom) || !isSide(left)) return null;
	return { top, right, bottom, left };
}

const isSide = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** `value` as a box's rotation, in degrees clockwise about its middle: none unless it is a finite number. */
export const rotationIn = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * How a box is drawn, as its node's attributes hold it. Every box has a
 * frame. Its fill and stroke colour its frame, or, when it has a path, the
 * shape the path outlines instead.
 */
export interface BoxAttributes {
	/** What it is for, or `null` for nothing in particular. */
	role: BoxRole | null;
	frame: Frame;
	/** What it is filled with, or `null` for nothing: the slide shows through. */
	fill: CssColor | null;
	stroke: Stroke | null;
	/** The outline of its shape, in its own pixels (see `svg-path.ts`), or `null` for its frame's rectangle. */
	path: SvgPath | null;
	verticalAlign: VerticalAlign;
	/** Its padding, or `null` for `DEFAULT_BOX_PADDING`. */
	padding: BoxPadding | null;
	/** In degrees clockwise about its middle. */
	rotation: number;
}

/** What a box is drawn with when it says nothing else, but for its frame, which it always says. */
export const DEFAULT_BOX_ATTRIBUTES: Omit<BoxAttributes, "frame"> = Object.freeze({
	role: null,
	fill: null,
	stroke: null,
	path: null,
	verticalAlign: "top",
	padding: null,
	rotation: 0,
});

/**
 * `attributes`, a box node's, read as `BoxAttributes`: each one that isn't
 * of its type read as the default, and a frame that isn't one as
 * `DEFAULT_BOX_FRAME`. A box's attributes come from people's editors, files
 * and bots, through the sync layer, so they are read through this.
 */
export function boxAttributesIn(attributes: Readonly<Record<string, unknown>>): BoxAttributes {
	return {
		role: boxRoleIn(attributes.role),
		frame: frameIn(attributes.frame) ?? DEFAULT_BOX_FRAME,
		fill: cssColorIn(attributes.fill),
		stroke: strokeIn(attributes.stroke),
		path: svgPathIn(attributes.path),
		verticalAlign: verticalAlignIn(attributes.verticalAlign),
		padding: paddingIn(attributes.padding),
		rotation: rotationIn(attributes.rotation),
	};
}
