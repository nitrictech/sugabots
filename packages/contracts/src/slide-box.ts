import { type CssColor, cssColorIn, isFiniteNumber } from "./css-values.ts";
import { DEFAULT_BOX_FRAME, type Frame, frameIn, SLIDE_REACH } from "./slide-geometry.ts";
import { changedPath, type SvgPath, svgPathIn } from "./svg-path.ts";

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

/** The thickest a box's outline may be, in a slide's pixels: PowerPoint's thickest line. */
export const THICKEST_STROKE = 1584;

/**
 * `value` as a stroke, or `null` unless it has a colour and a finite width
 * above 0. A width over `THICKEST_STROKE` is read as that.
 */
export function strokeIn(value: unknown): Stroke | null {
	if (typeof value !== "object" || value === null) return null;
	const { color, width } = value as Partial<Record<keyof Stroke, unknown>>;
	const strokeColor = cssColorIn(color);
	if (!strokeColor || !isFiniteNumber(width) || width <= 0) return null;
	return { color: strokeColor, width: Math.min(width, THICKEST_STROKE) };
}

/** The room inside a box's frame around what it holds, at each side, in a slide's pixels. */
export interface BoxPadding {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

/** No padding, which a box has unless it says otherwise: the layouts' frames are drawn for what is in them to fill. */
export const DEFAULT_BOX_PADDING: BoxPadding = Object.freeze({
	top: 0,
	right: 0,
	bottom: 0,
	left: 0,
});

/**
 * `value` as a box's padding, or `null` unless each side is a finite number
 * not below 0. A side over `SLIDE_REACH` is read as that.
 */
export function paddingIn(value: unknown): BoxPadding | null {
	if (typeof value !== "object" || value === null) return null;
	const { top, right, bottom, left } = value as Partial<Record<keyof BoxPadding, unknown>>;
	if (!isSide(top) || !isSide(right) || !isSide(bottom) || !isSide(left)) return null;
	const cut = (side: number) => Math.min(side, SLIDE_REACH);
	return { top: cut(top), right: cut(right), bottom: cut(bottom), left: cut(left) };
}

const isSide = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;

/** Whether `padding` is no padding at all, which a box stores as none. */
export const isNoPadding = ({ top, right, bottom, left }: BoxPadding): boolean =>
	top === 0 && right === 0 && bottom === 0 && left === 0;

/**
 * `value` as a box's rotation, in degrees clockwise about its middle: none
 * unless it is a finite number. One of more than a whole turn either way is
 * read as what is left of it after its whole turns, which draws the same.
 */
export const rotationIn = (value: unknown): number => {
	if (!isFiniteNumber(value)) return 0;
	return Math.abs(value) <= 360 ? value : value % 360;
};

/**
 * How a box is drawn, as its node's attributes hold it. Every box has a
 * frame. Its fill and stroke colour its frame, or, when it has a path, the
 * shape the path outlines instead.
 */
export interface BoxAttributes {
	/** What it is for, or `null` for nothing in particular. */
	readonly role: BoxRole | null;
	readonly frame: Frame;
	/** What it is filled with, or `null` for nothing: the slide shows through. */
	readonly fill: CssColor | null;
	readonly stroke: Stroke | null;
	/** The outline of its shape, in its frame's own pixels (see `svg-path.ts`), or `null` for its frame's rectangle. */
	readonly path: SvgPath | null;
	readonly verticalAlign: VerticalAlign;
	readonly padding: BoxPadding;
	/** In degrees clockwise about its middle. */
	readonly rotation: number;
}

/**
 * What a box is made or changed with: any of its attributes, its padding
 * `null` for none, which is how a box with no padding stores it.
 */
export type BoxChanges = Partial<Omit<BoxAttributes, "padding">> & {
	readonly padding?: BoxPadding | null;
};

/**
 * `attributes`, a box node's, read as `BoxAttributes`: each one that isn't
 * of its type read as its default, and a frame that isn't one as
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
		padding: paddingIn(attributes.padding) ?? DEFAULT_BOX_PADDING,
		rotation: rotationIn(attributes.rotation),
	};
}

/** Where a box sits and the outline of its shape, which change together. */
export type FramedShape = Pick<BoxAttributes, "frame" | "path">;

/**
 * `box` moved to `frame`, its path, if it has one, stretched to fill the new
 * frame as it filled the old: the one way a box takes a new frame, as a
 * path is in its frame's own pixels. Across a side of nothing, as a line's
 * height is, the path keeps that side as it is, having no size to stretch.
 */
export function withFrame(box: FramedShape, frame: Frame): FramedShape {
	const scale = (before: number, after: number) => (before === 0 ? 1 : after / before);
	const scaleX = scale(box.frame.width, frame.width);
	const scaleY = scale(box.frame.height, frame.height);
	if (!box.path || (scaleX === 1 && scaleY === 1)) return { frame, path: box.path };
	return { frame, path: changedPath(box.path, { scaleX, scaleY, moveX: 0, moveY: 0 }) };
}

/** `padding`, as a box stores it: `null` for none at all, so no padding is one value. */
export const storedPadding = (padding: BoxPadding | null | undefined): BoxPadding | null =>
	padding && !isNoPadding(padding) ? padding : null;
