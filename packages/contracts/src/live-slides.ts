import { getStyleProperty, mergeAttributes, Node as SchemaNode } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import {
	type DOMOutputSpec,
	Fragment,
	type Node,
	type NodeType,
	type Schema,
} from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import { type CssColor, cssColorIn, NUMBER_PATTERN, pixels, pixelsIn } from "./css-values.ts";
import type { PageChildElement, PageElement } from "./page-element.ts";
import {
	type BoxAttributes,
	type BoxChanges,
	type BoxPadding,
	type BoxRole,
	boxAttributesIn,
	boxRoleIn,
	isNoPadding,
	paddingIn,
	rotationIn,
	type Stroke,
	storedPadding,
	strokeIn,
	verticalAlignIn,
	withFrame,
} from "./slide-box.ts";
import { DEFAULT_BOX_FRAME, type Frame, frameIn } from "./slide-geometry.ts";
import {
	defaultFrameOf,
	relayoutRuleOf,
	type SlideLayout,
	slideLayoutIn,
	type TemplateBox,
	templateBoxesOf,
	templateBoxOf,
} from "./slide-layouts.ts";
import { changedPath, joinedPaths, pathOfShape, type SvgPath } from "./svg-path.ts";

/*
 * What a `slides` deck holds as a live document: slides, each holding boxes
 * placed freely on it, as in a presentation app, and the speaker's notes
 * below it. A box holds the blocks a document does, and says where it sits,
 * what it is for and how it is drawn (`BoxAttributes`); later boxes draw over
 * earlier ones. A slide says the layout it was last laid out by, a template
 * of boxes (`SLIDE_TEMPLATES`), and its background. The nodes here are a
 * deck's alone, so a document can't hold a slide.
 *
 * The schema's HTML is the form a deck is read and written in outside the
 * editor (see `deck-html.ts`), so it says everything a slide holds, in
 * inline styles a browser draws: every length in a slide's pixels (see
 * `slide-geometry.ts`), and nothing at its default.
 */

export const SLIDE = "slide";
export const SLIDE_BODY = "slideBody";
export const SLIDE_BOX = "slideBox";
export const SPEAKER_NOTES = "speakerNotes";

/**
 * The attribute of the element a drawn box holds its blocks in, inside the
 * box's own element, which may hold its shape's drawing beside it. Read from
 * HTML, a box holds the blocks in its element, in this one or not, as the
 * parser reads an element it knows nothing of by what it holds.
 */
export const BOX_CONTENT_ATTRIBUTE = "data-box-content";

/**
 * The sizes text on a slide is drawn at when its box's role sets its size,
 * as parts of its full size, largest first: the first at which it fits the
 * slide is the one it is drawn at, in the app and in a file the deck is saved
 * as. Text given a size of its own (see `slide-text-style.ts`) is drawn at
 * that size, never smaller.
 */
export const SLIDE_TEXT_STEPS = [1, 0.9, 0.8, 0.7] as const;

/** Throws a `RangeError` unless `node` is of the type `name`, which `what`, a reading of it, needs. */
function expectType(node: Node, name: string, what: string): void {
	if (node.type.name !== name) {
		throw new RangeError(`${what} is read from a ${name}, not a ${node.type.name}`);
	}
}

/** The slide's layout: the one it was last laid out by, or `blank` when it holds none this version knows. Throws a `RangeError` for any node but a slide. */
export function layoutOf(slide: Node): SlideLayout {
	expectType(slide, SLIDE, "A layout");
	return slideLayoutIn(slide.attrs.layout);
}

/** The colour the slide is drawn on, or `null` for the slide styles' own. Throws a `RangeError` for any node but a slide. */
export function backgroundOf(slide: Node): CssColor | null {
	expectType(slide, SLIDE, "A background");
	return cssColorIn(slide.attrs.background);
}

/** How `box`, one of a slide's boxes, is drawn, each attribute read as its type (see `boxAttributesIn`). Throws a `RangeError` for any node but a box. */
export function boxAttributesOf(box: Node): BoxAttributes {
	expectType(box, SLIDE_BOX, "How a box is drawn");
	return boxAttributesIn(box.attrs);
}

/** `slide`'s body, the first of what it holds, which holds its boxes. Throws a `RangeError` for any node but a slide. */
export function bodyOf(slide: Node): Node {
	expectType(slide, SLIDE, "A body");
	return slide.child(0);
}

/** `slide`'s speaker's notes, which follow its body. Throws a `RangeError` for any node but a slide. */
export function notesOf(slide: Node): Node {
	expectType(slide, SLIDE, "Speaker's notes");
	return slide.child(1);
}

/**
 * Where a slide's first box starts, counted from where the slide starts: past
 * the slide's own start and its body's, as its body is the first of what it
 * holds.
 */
export const FIRST_BOX_IN_SLIDE = 2;

/** A deck: its slides, and nothing else. */
export const Deck = Document.extend({ content: `${SLIDE}+` });

/**
 * A slide: its body (`bodyOf`), which holds its boxes, and the speaker's
 * notes for it (`notesOf`). Drawn, it is a section saying its layout, unless
 * that is `blank`, and its background, as `background`, when it has one:
 *
 *     <section data-slide data-layout="title" style="background: #0f172a">
 *
 * The section holds the notes too, so whatever draws the slide draws its
 * background behind its body alone (`backgroundOf`).
 */
export const Slide = SchemaNode.create({
	name: SLIDE,
	content: `${SLIDE_BODY} ${SPEAKER_NOTES}`,
	isolating: true,
	addAttributes: () => ({
		layout: {
			default: "blank" satisfies SlideLayout,
			parseHTML: (element) => slideLayoutIn(element.getAttribute("data-layout")),
			renderHTML: ({ layout }) => {
				const known = slideLayoutIn(layout);
				return known === "blank" ? {} : { "data-layout": known };
			},
		},
		background: {
			default: null,
			parseHTML: (element) => backgroundIn(element),
			renderHTML: ({ background }) => {
				const color = cssColorIn(background);
				return color ? { style: `background: ${color}` } : {};
			},
		},
	}),
	parseHTML: () => [{ tag: "section[data-slide]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"section",
		mergeAttributes({ "data-slide": "" }, HTMLAttributes),
		0,
	],
});

/** The colour an element's style gives its background, when that is a colour alone. */
const backgroundIn = (element: PageElement): CssColor | null =>
	cssColorIn(
		getStyleProperty(element, "background") ?? getStyleProperty(element, "background-color"),
	);

/** A slide's body: its boxes, any number of them, each drawn over those before it. */
export const SlideBody = SchemaNode.create({
	name: SLIDE_BODY,
	content: `${SLIDE_BOX}*`,
	isolating: true,
	parseHTML: () => [{ tag: "div[data-slide-body]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"div",
		mergeAttributes({ "data-slide-body": "" }, HTMLAttributes),
		0,
	],
});

/**
 * The attributes a box stores, each with the value it stores when it says
 * none, which the sync layer carries as they are and `boxAttributesIn` reads.
 * A box with no padding stores none, `null`.
 */
const STORED_BOX_DEFAULTS = {
	role: null,
	verticalAlign: "top",
	frame: DEFAULT_BOX_FRAME,
	fill: null,
	stroke: null,
	padding: null,
	rotation: 0,
	path: null,
} as const satisfies Record<keyof BoxAttributes, unknown>;

/** `changes` as a box stores them, those not given left out. */
function storedChanges(changes: BoxChanges): Record<string, unknown> {
	const { padding, ...others } = changes;
	const given = Object.entries(others).filter(([, value]) => value !== undefined);
	const stored = padding === undefined ? given : [...given, ["padding", storedPadding(padding)]];
	return Object.fromEntries(stored);
}

/**
 * A box on a slide, holding blocks one under another, its attributes saying
 * how it is drawn (`BoxAttributes`). Drawn, it is one element, written whole
 * (`boxElementAttributes`) and read whole (`storedAttributesOfBox`): its
 * frame, fill, stroke, padding and rotation as inline styles, what it is for
 * and where its blocks sit in it as data attributes, and its blocks in an
 * element of their own (`BOX_CONTENT_ATTRIBUTE`):
 *
 *     <div data-slide-box data-role="title" data-vertical-align="bottom"
 *       style="left: 80px; top: 100px; width: 800px; height: 176px;
 *         background: #1e3a8a; border: 2px solid #93c5fd; padding: 16px 24px;
 *         transform: rotate(-2deg)">
 *       <div data-box-content>…</div>
 *     </div>
 *
 * A box with a path is a shape: an SVG drawing of the path, its viewport the
 * box's own pixels (`drawnViewportOf`), comes before its blocks, filled and
 * stroked as the box is, and the box's own element is neither:
 *
 *     <div data-slide-box style="left: …">
 *       <svg viewBox="0 0 200 100" preserveAspectRatio="none"><path
 *         d="M 0 0 L 200 50 L 0 100 Z" fill="#f59e0b" stroke="#78350f"
 *         stroke-width="2"/></svg>
 *       <div data-box-content><p></p></div>
 *     </div>
 *
 * Read from HTML, it is forgiving, as bots write it by hand: a box saying no
 * frame takes the one its role's box has on its slide's layout
 * (`defaultFrameOf`), an unknown role is none, and a drawing may be any of
 * SVG's shapes, in any viewport, which is scaled to the box's (see
 * `shapeOf`).
 */
export const SlideBox = SchemaNode.create({
	name: SLIDE_BOX,
	content: "block+",
	isolating: true,
	addAttributes: () =>
		Object.fromEntries(
			Object.entries(STORED_BOX_DEFAULTS).map(([name, value]) => [
				name,
				// Written and read with the box's element whole, below, not one by one.
				{ default: value, rendered: false, parseHTML: () => null },
			]),
		),
	parseHTML: () => [{ tag: "div[data-slide-box]", getAttrs: storedAttributesOfBox }],
	renderHTML: ({ node, HTMLAttributes }) => {
		const attributes = boxAttributesOf(node);
		const shape = attributes.path ? [drawnShape(attributes.path, attributes)] : [];
		return [
			"div",
			mergeAttributes({ "data-slide-box": "" }, HTMLAttributes, boxElementAttributes(attributes)),
			...shape,
			["div", { [BOX_CONTENT_ATTRIBUTE]: "" }, 0],
		];
	},
});

/** The attribute a drawn box says where its blocks sit in it with, when not at its top. */
const VERTICAL_ALIGN_ATTRIBUTE = "data-vertical-align";

/** The attributes of a drawn box's element, saying how it is drawn but for its shape's drawing (`drawnShape`). */
function boxElementAttributes(attributes: BoxAttributes): Record<string, string> {
	const { role, verticalAlign, frame, fill, stroke, path, padding, rotation } = attributes;
	const style = [
		`left: ${pixels(frame.x)}; top: ${pixels(frame.y)}; width: ${pixels(frame.width)}; height: ${pixels(frame.height)}`,
		fill && !path ? `background: ${fill}` : undefined,
		stroke && !path ? `border: ${pixels(stroke.width)} solid ${stroke.color}` : undefined,
		isNoPadding(padding) ? undefined : `padding: ${paddingText(padding)}`,
		rotation === 0 ? undefined : `transform: rotate(${rotation}deg)`,
	];
	return {
		...(role ? { "data-role": role } : {}),
		...(verticalAlign === "top" ? {} : { [VERTICAL_ALIGN_ATTRIBUTE]: verticalAlign }),
		style: style.filter((declaration) => declaration !== undefined).join("; "),
	};
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The viewport a shape of a box framed at `frame` is drawn in: the frame's
 * own pixels, but at least one each way, as a viewport of no size draws
 * nothing and a line's box may be of no height. Its path is unchanged.
 */
const drawnViewportOf = ({ width, height }: Frame) => ({
	width: Math.max(1, width),
	height: Math.max(1, height),
});

/**
 * A shape's drawing: its path, in a viewport of the box's own pixels, filled
 * and stroked as the box is. Drawn at another size, as while an editor
 * resizes the box, it stretches to fill it, as its path is stretched once
 * the box is (`withFrame`), and as a drawing read from HTML is taken to (see
 * `shapeOf`).
 */
function drawnShape(
	path: SvgPath,
	{ frame, fill, stroke }: Pick<BoxAttributes, "frame" | "fill" | "stroke">,
): DOMOutputSpec {
	const viewport = drawnViewportOf(frame);
	return [
		`${SVG_NAMESPACE} svg`,
		{ viewBox: `0 0 ${viewport.width} ${viewport.height}`, preserveAspectRatio: "none" },
		[
			"path",
			{
				d: path,
				// What SVG fills a path with when told nothing is black, so a shape without a fill says so.
				fill: fill ?? "none",
				stroke: stroke?.color ?? null,
				"stroke-width": stroke ? String(stroke.width) : null,
			},
		],
	];
}

/** A box's padding as CSS's shorthand writes it: as few lengths as say all four sides. */
function paddingText({ top, right, bottom, left }: BoxPadding): string {
	const sides = [top, right, bottom, left];
	if (left === right) sides.pop();
	if (left === right && bottom === top) sides.pop();
	if (left === right && bottom === top && right === top) sides.pop();
	return sides.map(pixels).join(" ");
}

/** The attributes the drawn box `box` says, as a box stores them, each read once. */
function storedAttributesOfBox(box: PageElement): Record<keyof BoxAttributes, unknown> {
	const frame = frameOfBox(box);
	const background = backgroundIn(box);
	const shape = shapeOf(box, frame, background);
	return {
		role: boxRoleIn(box.getAttribute("data-role")),
		verticalAlign: verticalAlignIn(box.getAttribute(VERTICAL_ALIGN_ATTRIBUTE)),
		frame,
		fill: shape ? shape.fill : background,
		stroke: shape ? shape.stroke : borderOf(box),
		padding: storedPadding(paddingOf(box)),
		rotation: rotationOf(box),
		path: shape?.path ?? null,
	};
}

/**
 * The frame a drawn box's style gives it, in pixels: its `left`, `top`,
 * `width` and `height`. What it leaves out, it has of the frame its role's box
 * has on its slide's layout (`defaultFrameOf`), and a frame it gives that is
 * none, such as one of a negative width, is that frame whole.
 */
function frameOfBox(box: PageElement): Frame {
	const slide = box.closest("section[data-slide]");
	const fallback = defaultFrameOf(
		boxRoleIn(box.getAttribute("data-role")),
		slideLayoutIn(slide?.getAttribute("data-layout")),
	);
	const given = (property: string) => pixelsIn(getStyleProperty(box, property));
	const frame = frameIn({
		x: given("left") ?? fallback.x,
		y: given("top") ?? fallback.y,
		width: given("width") ?? fallback.width,
		height: given("height") ?? fallback.height,
	});
	return frame ?? fallback;
}

/** The shape a box's drawing draws (`shapeOf`), and how it is filled and stroked. */
interface DrawnShape {
	readonly path: SvgPath;
	readonly fill: CssColor | null;
	readonly stroke: Stroke | null;
}

const SHAPES = "path, polygon, polyline, line, rect, circle, ellipse";

/** What holds shapes an SVG drawing uses elsewhere without drawing them where they stand. */
const UNDRAWN = new Set(["defs", "symbol", "marker", "pattern", "mask", "clippath"]);

/** What SVG fills a shape with when it says nothing of its fill. */
const SVG_FILL = cssColorIn("black");

/**
 * The shape the drawn box `box`, framed at `frame`, draws, when it is a
 * shape: every shape its SVG drawing draws, as one path (`joinedPaths`),
 * moved and scaled from the drawing's viewport into the box's pixels, as the
 * drawing would draw it across the box, and filled and stroked as its first
 * shape says. A shape that says no fill is filled as SVG fills one, black,
 * unless the box's style gives it a background, as a bot may write a shape's
 * fill. Words in the drawing, as a label, are read as words the box holds.
 */
function shapeOf(
	box: PageElement,
	frame: Frame,
	background: CssColor | null,
): DrawnShape | undefined {
	const drawing = [...box.children].find((child) => child.localName.toLowerCase() === "svg");
	if (!drawing) return undefined;
	const drawn = [...drawing.querySelectorAll(SHAPES)].flatMap((element) => {
		const path = isDrawn(element, drawing) ? pathOfShape(element) : null;
		return path ? [{ element, path }] : [];
	});
	const [first] = drawn;
	const joined = joinedPaths(drawn.map((shape) => shape.path));
	if (!first || !joined) return undefined;
	const fill = paintOf(first.element, "fill");
	return {
		path: inBoxPixels(joined, drawing, frame),
		fill: fill === null ? (background ?? SVG_FILL) : cssColorIn(fill),
		stroke: strokeIn({
			color: cssColorIn(paintOf(first.element, "stroke")),
			width: pixelsIn(paintOf(first.element, "stroke-width")) ?? 1,
		}),
	};
}

/** Whether `shape` is drawn where it stands in `drawing`, not held for use elsewhere (`UNDRAWN`). */
function isDrawn(shape: PageChildElement, drawing: PageChildElement): boolean {
	for (
		let holder = shape.parentElement;
		holder && holder !== drawing;
		holder = holder.parentElement
	) {
		if (UNDRAWN.has(holder.localName.toLowerCase())) return false;
	}
	return true;
}

/** `path`, in the viewport of `drawing`, moved and scaled into the pixels of a box framed at `frame`. */
function inBoxPixels(path: SvgPath, drawing: PageChildElement, frame: Frame): SvgPath {
	const [minX = 0, minY = 0, width = 0, height = 0] = (drawing.getAttribute("viewBox") ?? "")
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const viewport = drawnViewportOf(frame);
	const isViewport = [minX, minY, width, height].every(Number.isFinite) && width > 0 && height > 0;
	const isBoxPixels =
		minX === 0 && minY === 0 && width === viewport.width && height === viewport.height;
	if (!isViewport || isBoxPixels) return path;
	const scaleX = frame.width / width;
	const scaleY = frame.height / height;
	return changedPath(path, { scaleX, scaleY, moveX: -minX * scaleX, moveY: -minY * scaleY });
}

/**
 * A shape's paint property `name`, as its style says it, or else its
 * attribute. Tiptap's reader of a style is typed for HTML elements, but
 * reads only the `style` attribute, which an SVG element has as well.
 */
const paintOf = (shape: PageChildElement, name: string): string | null =>
	getStyleProperty(shape as PageElement, name) ?? shape.getAttribute(name);

/**
 * A drawn box's outline, for a box that is no shape: its style's `border`,
 * its width in pixels and its colour, a pixel wide when it gives none.
 */
function borderOf(box: PageElement): Stroke | null {
	const words = (getStyleProperty(box, "border") ?? "").match(/[a-z-]+\([^)]*\)|\S+/gi) ?? [];
	const width = words.map(pixelsIn).find((each) => each !== undefined);
	const color = words.map(cssColorIn).find((each) => each !== null);
	return strokeIn({
		color: color ?? cssColorIn(getStyleProperty(box, "border-color")),
		width: width ?? pixelsIn(getStyleProperty(box, "border-width")) ?? 1,
	});
}

/** A drawn box's padding, as its style's `padding` gives it in one to four lengths in pixels. */
function paddingOf(box: PageElement): BoxPadding | null {
	const lengths = (getStyleProperty(box, "padding") ?? "").trim().split(/\s+/).map(pixelsIn);
	if (lengths.length > 4 || lengths.some((length) => length === undefined)) return null;
	const [top, right = top, bottom = top, left = right] = lengths;
	return paddingIn({ top, right, bottom, left });
}

/** A rotation in degrees, as `rotate(15deg)` or `15deg` says it. */
const DEGREES = new RegExp(
	String.raw`^\s*(?:rotate\(\s*)?(${NUMBER_PATTERN})(?:deg)?\s*\)?\s*$`,
	"i",
);

/** A drawn box's rotation, as its style's `transform` or `rotate` gives it in degrees (see `rotationIn`). */
function rotationOf(box: PageElement): number {
	const transform = /rotate\([^)]*\)/i.exec(getStyleProperty(box, "transform") ?? "")?.[0];
	const [, degrees] = DEGREES.exec(transform ?? getStyleProperty(box, "rotate") ?? "") ?? [];
	return rotationIn(Number(degrees));
}

/**
 * What the speaker says over a slide: plain paragraphs, which several people
 * can type in at once as they can in a document.
 */
export const SpeakerNotes = SchemaNode.create({
	name: SPEAKER_NOTES,
	content: "paragraph+",
	isolating: true,
	parseHTML: () => [{ tag: "aside[data-speaker-notes]" }],
	renderHTML: ({ HTMLAttributes }) => [
		"aside",
		mergeAttributes({ "data-speaker-notes": "" }, HTMLAttributes),
		0,
	],
});

/** What a box is to be made with: its frame, which every box has, and any of its other attributes. */
export type NewBoxAttributes = BoxChanges & Pick<BoxAttributes, "frame">;

/**
 * A new box of `schema` drawn as `attributes` say, its other attributes at
 * their defaults, holding `content`: an empty paragraph when that is nothing.
 * Its path, if it has one, is in the pixels of the frame it is given. Throws
 * a `RangeError` when a box can't hold `content`, as text, which goes in a
 * paragraph.
 */
export function newBox(
	schema: Schema,
	attributes: NewBoxAttributes,
	content: readonly Node[] | Fragment,
): Node {
	const box = nodeType(schema, SLIDE_BOX).createAndFill(
		{ ...STORED_BOX_DEFAULTS, ...storedChanges(attributes) },
		Fragment.from(content as Node[] | Fragment),
	);
	if (!box) throw new RangeError("A slide's box holds blocks, which this content is not");
	return box;
}

/**
 * `change` with the box starting at `boxPos` drawn as `changes` say, its
 * other attributes as they were. A new frame given without a path stretches
 * the box's shape, if it is one, to fill the new frame as it filled the old
 * (`withFrame`); a path given with it is taken to be in the new frame's
 * pixels. Throws a `RangeError` when no box starts at `boxPos`.
 */
export function setBoxAttributes<T extends Transform>(
	change: T,
	boxPos: number,
	changes: BoxChanges,
): T {
	const box = change.doc.nodeAt(boxPos);
	if (box?.type.name !== SLIDE_BOX) throw new RangeError(`No slide's box starts at ${boxPos}`);
	const current = boxAttributesOf(box);
	const stretched =
		changes.frame && changes.path === undefined && current.path
			? { path: withFrame(current, changes.frame).path }
			: {};
	for (const [name, value] of Object.entries(storedChanges({ ...changes, ...stretched }))) {
		change.setNodeAttribute(boxPos, name, value);
	}
	return change;
}

/** The level of a slide's title: a title slide's is the deck's own, a level one heading, and every other's level two. */
const titleLevel = (layout: SlideLayout) => (layout === "title" ? 1 : 2);

/** How many columns a table on a new slide has. */
const NEW_TABLE_COLUMNS = 3;

/**
 * What a box of `role` on a slide of `layout` holds while nothing is typed in
 * it, so what is typed there is what the box is for: an empty heading at the
 * slide's title level for a title, an empty bulleted list for a body, an
 * empty table, a row of headers over two rows, for a table, an empty quote
 * for a quote, and an empty paragraph for any other. The editor names an
 * empty box with words that are not stored.
 */
function startingContent(schema: Schema, layout: SlideLayout, role: BoxRole): Node {
	const node = (name: string, content?: Node | Node[], attributes?: Record<string, unknown>) =>
		nodeType(schema, name).create(attributes ?? null, content);
	const paragraph = () => node("paragraph");
	const row = (cell: "tableHeader" | "tableCell") =>
		node(
			"tableRow",
			Array.from({ length: NEW_TABLE_COLUMNS }, () => node(cell, paragraph())),
		);
	switch (role) {
		case "title":
			return node("heading", undefined, { level: titleLevel(layout) });
		case "body":
			return node("bulletList", node("listItem", paragraph()));
		case "table":
			return node("table", [row("tableHeader"), row("tableCell"), row("tableCell")]);
		case "quote":
			return node("blockquote", paragraph());
		default:
			return paragraph();
	}
}

/** The attributes a box takes where `template` places it: its role, frame and vertical alignment, unrotated. */
const placedBy = ({ role, frame, verticalAlign }: TemplateBox): NewBoxAttributes => ({
	role,
	frame,
	verticalAlign,
	rotation: 0,
});

/**
 * `box` placed where `template` places a box, holding `content`, its shape,
 * if it is one, stretched to its new frame (`withFrame`): `box` itself when it
 * is so placed already.
 */
function placedByTemplate(box: Node, template: TemplateBox, content: Fragment): Node {
	const moved = withFrame(boxAttributesOf(box), template.frame);
	const attributes = { ...box.attrs, ...storedChanges({ ...placedBy(template), ...moved }) };
	const placed = box.type.create(attributes, content, box.marks);
	return placed.eq(box) ? box : placed;
}

/**
 * A new slide of `layout`, as the editor adds one: a box for each its
 * template places (`SLIDE_TEMPLATES`), where it places it, holding what a box
 * of its role starts with (`startingContent`), and empty notes.
 */
export function newSlide(schema: Schema, layout: SlideLayout): Node {
	const boxes = templateBoxesOf(layout).map((template) =>
		newBox(schema, placedBy(template), [startingContent(schema, layout, template.role)]),
	);
	return nodeType(schema, SLIDE).create({ layout }, [
		nodeType(schema, SLIDE_BODY).create(null, boxes),
		nodeType(schema, SPEAKER_NOTES).create(null, nodeType(schema, "paragraph").create()),
	]);
}

/** One of a slide's boxes, and its place among them. */
interface BoxInSlide {
	readonly node: Node;
	readonly index: number;
}

/** Blocks a box of a slide gives the box of a role in the slide's new layout, and the box, unless they are only part of what it held. */
interface Handover {
	readonly from: BoxInSlide | undefined;
	readonly blocks: readonly Node[];
}

/** What a slide's boxes with a role do when it is laid out anew (`claimsOf`). Boxes with no role stay as they are. */
interface Claims {
	/** The first box of each role the new layout places, which keeps its role, and what it keeps. */
	readonly byRole: ReadonlyMap<BoxRole, Handover>;
	/** Every other box with a role, in order, with blocks a box claiming a role doesn't keep, where they stood. */
	readonly leftovers: readonly Handover[];
	/** The places of the boxes that go, holding nothing that needs a place (see `relayoutRuleOf`). */
	readonly going: readonly number[];
}

/** A box of the new layout's template, filled (`filledBox`), and the slide's boxes it takes the place of. */
interface FilledBox {
	/** The place among the slide's boxes it is drawn at, or none for a box added over the others. */
	readonly at: number | undefined;
	readonly node: Node;
	/** The places of the other boxes whose blocks it took, which go. */
	readonly absorbs: readonly number[];
}

/**
 * `slide` laid out by `layout`, as a change of a slide's layout lays it out,
 * whoever makes it, having lost nothing, in three steps:
 *
 * 1. The first box of each role the new layout places claims that role, and
 *    every other box with a role is left over (`claimsOf`).
 * 2. Each leftover goes to a role of the new layout no box claimed, one each,
 *    in order, those past the last joining it; with every role claimed, they
 *    join the last role (`takerOf`). A layout that places no boxes, `blank`,
 *    leaves them where they are.
 * 3. Each role of the new layout is filled where its template places it,
 *    with what its claim keeps and then what its leftovers hold, in the
 *    place of the first box among them, or added over the others when none
 *    (`filledBox`).
 *
 * How a role fares apart from that is data: what a section break's title
 * keeps on leaving it (`keepsOnLeaving`), and a label, which is given no
 * other box's blocks and goes when it holds nothing (`relayoutRuleOf`). Boxes
 * with no role are left exactly as they are. `slide` itself when that changes
 * nothing.
 */
export function laidOutAnew(slide: Node, layout: SlideLayout): Node {
	const schema = slide.type.schema;
	const templates = templateBoxesOf(layout);
	const claims = claimsOf(slide, layout);
	const takers = claims.leftovers.map((_, index) => takerOf(index, templates, claims.byRole));
	const filled = templates.map((template) =>
		filledBox(
			schema,
			layout,
			template,
			claims.byRole.get(template.role),
			claims.leftovers.filter((_, index) => takers[index] === template.role),
		),
	);
	const gone = new Set([...claims.going, ...filled.flatMap((box) => box.absorbs)]);
	const replacing = new Map(
		filled.flatMap((box) => (box.at === undefined ? [] : [[box.at, box.node]])),
	);
	const kept = bodyOf(slide).children.flatMap((node, index) =>
		gone.has(index) ? [] : [replacing.get(index) ?? node],
	);
	const added = filled.filter((box) => box.at === undefined).map((box) => box.node);
	return withBoxes(slide, { layout }, [...kept, ...added]);
}

/** What `slide`'s boxes with a role do when it is laid out by `layout` (see `Claims`). */
function claimsOf(slide: Node, layout: SlideLayout): Claims {
	const was = layoutOf(slide);
	const roles = templateBoxesOf(layout).map(({ role }) => role);
	const byRole = new Map<BoxRole, Handover>();
	const leftovers: Handover[] = [];
	const going: number[] = [];
	bodyOf(slide).forEach((node, _offset, index) => {
		const { role } = boxAttributesOf(node);
		if (role === null) return;
		const blocks = node.content.content;
		if (roles.includes(role) && !byRole.has(role)) {
			const leaving = was !== layout ? templateBoxOf(was, role)?.keepsOnLeaving : undefined;
			const kept = leaving === "leadingHeading" ? leadingHeading(blocks) : blocks;
			byRole.set(role, { from: { node, index }, blocks: kept });
			if (kept.length < blocks.length) {
				leftovers.push({ from: undefined, blocks: blocks.slice(kept.length) });
			}
		} else if (relayoutRuleOf(role).goesWhenEmpty && holdsNothing(node) && roles.length > 0) {
			going.push(index);
		} else {
			leftovers.push({ from: { node, index }, blocks });
		}
	});
	return { byRole, leftovers, going };
}

/** The heading `blocks` start with, if they start with one. */
const leadingHeading = (blocks: readonly Node[]) =>
	blocks[0]?.type.name === "heading" ? blocks.slice(0, 1) : [];

/**
 * The role of the new layout, placed by `templates`, that takes the
 * `index`th leftover: the roles that take others and no box claimed, one each
 * in order, the last taking those past it; with every such role claimed, the
 * last role that takes others; none, for a layout that places nothing.
 */
function takerOf(
	index: number,
	templates: readonly TemplateBox[],
	claimed: ReadonlyMap<BoxRole, Handover>,
): BoxRole | undefined {
	const takers = templates
		.map(({ role }) => role)
		.filter((role) => relayoutRuleOf(role).takesOthers);
	const unclaimed = takers.filter((role) => !claimed.has(role));
	return unclaimed[Math.min(index, unclaimed.length - 1)] ?? takers.at(-1);
}

/**
 * The box of `template`'s role in the new layout: what `claim` keeps, then
 * what `given` hold, but for a leftover holding nothing, which gives nothing
 * but keeps its turn, so a right column stays the right one. A box left
 * holding nothing holds what a new box of its role does. It takes the place
 * of the first box among them, and the others' boxes go.
 */
function filledBox(
	schema: Schema,
	layout: SlideLayout,
	template: TemplateBox,
	claim: Handover | undefined,
	given: readonly Handover[],
): FilledBox {
	const blocks = [
		...(claim?.blocks ?? []),
		...given.flatMap(({ blocks }) => (blocks.every(holdsNothing) ? [] : blocks)),
	];
	const content = Fragment.fromArray(
		blocks.length > 0 ? blocks : [startingContent(schema, layout, template.role)],
	);
	const hosts = [claim, ...given].flatMap((handover) => (handover?.from ? [handover.from] : []));
	const [host, ...absorbed] = hosts;
	return {
		at: host?.index,
		node: host
			? placedByTemplate(host.node, template, content)
			: newBox(schema, placedBy(template), content),
		absorbs: absorbed.map(({ index }) => index),
	};
}

/**
 * `slide` with the first box of each role its layout places put back where
 * the layout's template places it, its shape stretched with it, as the
 * layout's "Reset layout" puts it: a second box of a role, every other box,
 * and what each holds, as they are. `slide` itself when that changes nothing.
 */
export function resetToTemplate(slide: Node): Node {
	const layout = layoutOf(slide);
	const boxes = bodyOf(slide).children;
	const roles = boxes.map((box) => boxAttributesOf(box).role);
	const reset = boxes.map((box, index) => {
		const role = roles[index];
		const template = role ? templateBoxOf(layout, role) : undefined;
		const isFirstOfRole = roles.indexOf(role ?? null) === index;
		return template && isFirstOfRole ? placedByTemplate(box, template, box.content) : box;
	});
	return withBoxes(slide, {}, reset);
}

/** `slide` with `attributes` and its body holding `boxes`: `slide` itself when that changes nothing. */
function withBoxes(slide: Node, attributes: Record<string, unknown>, boxes: readonly Node[]): Node {
	const body = bodyOf(slide);
	const changed = slide.type.create(
		{ ...slide.attrs, ...attributes },
		slide.content.replaceChild(0, body.copy(Fragment.fromArray([...boxes]))),
		slide.marks,
	);
	return changed.eq(slide) ? slide : changed;
}

/** Whether `holder`, a box or a block, holds no words, images or anything else on a line: nothing but empty lines, as of an empty list or table. */
function holdsNothing(holder: Node): boolean {
	let nothing = true;
	holder.descendants((node) => {
		if (node.isInline) nothing = false;
		return nothing;
	});
	return nothing;
}

function nodeType(schema: Schema, name: string): NodeType {
	const type = schema.nodes[name];
	if (!type) throw new Error(`The schema has no ${name} node`);
	return type;
}
