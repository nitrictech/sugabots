import { mergeAttributes, Node as SchemaNode } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import {
	type DOMOutputSpec,
	Fragment,
	type Node,
	type NodeType,
	type Schema,
} from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import {
	type CssColor,
	cssColorIn,
	pixels,
	pixelsIn,
	type StyledElement,
	styleProperty,
} from "./css-values.ts";
import {
	type BoxAttributes,
	type BoxPadding,
	type BoxRole,
	boxAttributesIn,
	boxRoleIn,
	DEFAULT_BOX_ATTRIBUTES,
	paddingIn,
	type Stroke,
	strokeIn,
	verticalAlignIn,
} from "./slide-box.ts";
import { DEFAULT_BOX_FRAME, type Frame, frameIn } from "./slide-geometry.ts";
import {
	defaultFrameOf,
	SLIDE_TEMPLATES,
	type SlideLayout,
	slideLayoutIn,
	type TemplateBox,
	templateBoxOf,
} from "./slide-layouts.ts";
import { changedPath, pathOfShape, type SvgPath } from "./svg-path.ts";

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
 * An element of a page being read, as far as reading a slide's box from it
 * goes. The API reads HTML with a DOM of its own and is built without the
 * browser's types, so an element is typed by the little of it that is read.
 */
interface ElementInPage extends StyledElement {
	readonly localName: string;
	readonly children: Iterable<ElementInPage>;
	closest(selector: string): StyledElement | null;
	querySelectorAll(selector: string): Iterable<ElementInPage>;
}

/**
 * The sizes text on a slide is drawn at when its box's role sets its size,
 * as parts of its full size, largest first: the first at which it fits the
 * slide is the one it is drawn at, in the app and in a file the deck is saved
 * as. Text given a size of its own (see `slide-text-style.ts`) is drawn at
 * that size, never smaller.
 */
export const SLIDE_TEXT_STEPS = [1, 0.9, 0.8, 0.7] as const;

/** The slide's layout: the one it was last laid out by, or `blank` when it holds none this version knows. */
export const layoutOf = (slide: Node): SlideLayout => slideLayoutIn(slide.attrs.layout);

/** The colour the slide is drawn on, or `null` for the slide styles' own. */
export const backgroundOf = (slide: Node): CssColor | null => cssColorIn(slide.attrs.background);

/** How `box`, one of a slide's boxes, is drawn, each attribute read as its type (see `boxAttributesIn`). */
export const boxAttributesOf = (box: Node): BoxAttributes => boxAttributesIn(box.attrs);

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
const backgroundIn = (element: StyledElement): CssColor | null =>
	cssColorIn(styleProperty(element, "background") ?? styleProperty(element, "background-color"));

/** `slide`'s body, the first of what it holds, which holds its boxes. */
export const bodyOf = (slide: Node): Node => slide.child(0);

/** `slide`'s speaker's notes, which follow its body. */
export const notesOf = (slide: Node): Node => slide.child(1);

/**
 * Where a slide's first box starts, counted from where the slide starts: past
 * the slide's own start and its body's, as its body is the first of what it
 * holds.
 */
export const FIRST_BOX_IN_SLIDE = 2;

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
 * A box on a slide, holding blocks one under another, its attributes saying
 * how it is drawn (`BoxAttributes`). Drawn, it is an element with its frame,
 * fill, stroke, padding and rotation as inline styles, what it is for and
 * where its blocks sit in it as data attributes, and its blocks in an element
 * of their own (`BOX_CONTENT_ATTRIBUTE`):
 *
 *     <div data-slide-box data-role="title" data-vertical-align="bottom"
 *       style="left: 80px; top: 100px; width: 800px; height: 176px;
 *         background: #1e3a8a; border: 2px solid #93c5fd; padding: 16px 24px;
 *         transform: rotate(-2deg)">
 *       <div data-box-content>…</div>
 *     </div>
 *
 * A box with a path is a shape: an SVG drawing of the path, its viewport the
 * box's own pixels, comes before its blocks, filled and stroked as the box
 * is, and the box's own element is neither:
 *
 *     <div data-slide-box style="left: …">
 *       <svg viewBox="0 0 200 100"><path d="M 0 0 L 200 50 L 0 100 Z"
 *         fill="#f59e0b" stroke="#78350f" stroke-width="2"/></svg>
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
	addAttributes: () => ({
		role: {
			default: DEFAULT_BOX_ATTRIBUTES.role,
			parseHTML: (element) => boxRoleIn(element.getAttribute("data-role")),
			renderHTML: (attributes) => {
				const { role } = boxAttributesIn(attributes);
				return role ? { "data-role": role } : {};
			},
		},
		verticalAlign: {
			default: DEFAULT_BOX_ATTRIBUTES.verticalAlign,
			parseHTML: (element) => verticalAlignIn(element.getAttribute(VERTICAL_ALIGN_ATTRIBUTE)),
			renderHTML: (attributes) => {
				const { verticalAlign } = boxAttributesIn(attributes);
				return verticalAlign === "top" ? {} : { [VERTICAL_ALIGN_ATTRIBUTE]: verticalAlign };
			},
		},
		frame: {
			default: DEFAULT_BOX_FRAME,
			parseHTML: (element) => frameOfBox(element),
			renderHTML: (attributes) => {
				const { x, y, width, height } = boxAttributesIn(attributes).frame;
				return {
					style: `left: ${pixels(x)}; top: ${pixels(y)}; width: ${pixels(width)}; height: ${pixels(height)}`,
				};
			},
		},
		fill: {
			default: DEFAULT_BOX_ATTRIBUTES.fill,
			parseHTML: (element) => fillOfBox(element),
			renderHTML: (attributes) => {
				const { fill, path } = boxAttributesIn(attributes);
				return fill && !path ? { style: `background: ${fill}` } : {};
			},
		},
		stroke: {
			default: DEFAULT_BOX_ATTRIBUTES.stroke,
			parseHTML: (element) => strokeOfBox(element),
			renderHTML: (attributes) => {
				const { stroke, path } = boxAttributesIn(attributes);
				return stroke && !path
					? { style: `border: ${pixels(stroke.width)} solid ${stroke.color}` }
					: {};
			},
		},
		padding: {
			default: DEFAULT_BOX_ATTRIBUTES.padding,
			parseHTML: (element) => paddingOfBox(element),
			renderHTML: (attributes) => {
				const { padding } = boxAttributesIn(attributes);
				return padding ? { style: `padding: ${paddingText(padding)}` } : {};
			},
		},
		rotation: {
			default: DEFAULT_BOX_ATTRIBUTES.rotation,
			parseHTML: (element) => rotationOfBox(element),
			renderHTML: (attributes) => {
				const { rotation } = boxAttributesIn(attributes);
				return rotation === 0 ? {} : { style: `transform: rotate(${rotation}deg)` };
			},
		},
		path: {
			default: DEFAULT_BOX_ATTRIBUTES.path,
			rendered: false,
			parseHTML: (element) => shapeOf(element)?.path ?? null,
		},
	}),
	parseHTML: () => [{ tag: "div[data-slide-box]" }],
	renderHTML: ({ node, HTMLAttributes }) => {
		const attributes = boxAttributesOf(node);
		const shape = attributes.path ? [drawnShape(attributes.path, attributes)] : [];
		return [
			"div",
			mergeAttributes({ "data-slide-box": "" }, HTMLAttributes),
			...shape,
			["div", { [BOX_CONTENT_ATTRIBUTE]: "" }, 0],
		];
	},
});

/** The attribute a drawn box says where its blocks sit in it with, when not at its top. */
const VERTICAL_ALIGN_ATTRIBUTE = "data-vertical-align";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * A shape's drawing: its path, in a viewport of the box's own pixels, filled
 * and stroked as the box is. Drawn at another size, as while an editor
 * resizes the box, it stretches to fill it, as its path is stretched once
 * the box is, and as a drawing read from HTML is taken to (see `shapeOf`).
 */
function drawnShape(
	path: SvgPath,
	{ frame, fill, stroke }: Pick<BoxAttributes, "frame" | "fill" | "stroke">,
): DOMOutputSpec {
	return [
		`${SVG_NAMESPACE} svg`,
		{ viewBox: `0 0 ${frame.width} ${frame.height}`, preserveAspectRatio: "none" },
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

/**
 * The frame a drawn box's style gives it, in pixels: its `left`, `top`,
 * `width` and `height`. What it leaves out, it has of the frame its role's box
 * has on its slide's layout (`defaultFrameOf`), and a frame it gives that is
 * none, such as one of a negative width, is that frame whole.
 */
function frameOfBox(element: ElementInPage): Frame {
	const slide = element.closest("section[data-slide]");
	const fallback = defaultFrameOf(
		boxRoleIn(element.getAttribute("data-role")),
		slideLayoutIn(slide?.getAttribute("data-layout")),
	);
	const given = (property: string) => pixelsIn(styleProperty(element, property));
	const frame = frameIn({
		x: given("left") ?? fallback.x,
		y: given("top") ?? fallback.y,
		width: given("width") ?? fallback.width,
		height: given("height") ?? fallback.height,
	});
	return frame ?? fallback;
}

/** The shape a box's drawing draws (`shapeOf`), its paint read from its first shape's attributes or style. */
interface DrawnShape {
	path: SvgPath;
	/** The first shape's element, which says its fill and stroke. */
	element: ElementInPage;
}

const SHAPES = "path, polygon, polyline, line, rect, circle, ellipse";

/**
 * The shape a drawn box draws, when it is a shape: every shape in the SVG
 * drawing among its children, as one path, moved and scaled from the
 * drawing's viewport into the box's pixels, as the drawing would draw it
 * across the box.
 */
function shapeOf(box: ElementInPage): DrawnShape | undefined {
	const drawing = [...box.children].find((child) => child.localName.toLowerCase() === "svg");
	const shapes = drawing ? [...drawing.querySelectorAll(SHAPES)] : [];
	const drawn = shapes.flatMap((element) => {
		const path = pathOfShape(element);
		return path ? [{ element, path }] : [];
	});
	const [first] = drawn;
	if (!drawing || !first) return undefined;
	const path = drawn.map((shape) => shape.path).join(" ") as SvgPath;
	const [minX = 0, minY = 0, width = 0, height = 0] = (drawing.getAttribute("viewBox") ?? "")
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const frame = frameOfBox(box);
	const isViewport = [minX, minY, width, height].every(Number.isFinite) && width > 0 && height > 0;
	const isBoxPixels = minX === 0 && minY === 0 && width === frame.width && height === frame.height;
	if (!isViewport || isBoxPixels) return { path, element: first.element };
	const scaleX = frame.width / width;
	const scaleY = frame.height / height;
	const inBox = changedPath(path, { scaleX, scaleY, moveX: -minX * scaleX, moveY: -minY * scaleY });
	return { path: inBox, element: first.element };
}

/** A shape's paint property `name`, as its style says it, or else its attribute. */
const paintOf = (shape: StyledElement, name: string): string | null =>
	styleProperty(shape, name) ?? shape.getAttribute(name);

/**
 * A drawn box's fill: a shape's, or, for a box that is no shape, the colour
 * its style gives its background. A shape that says no fill is filled as SVG
 * fills it, with the box's background when it has one and black otherwise.
 */
function fillOfBox(element: ElementInPage): CssColor | null {
	const shape = shapeOf(element);
	if (!shape) return backgroundIn(element);
	const fill = paintOf(shape.element, "fill");
	return fill === null ? (backgroundIn(element) ?? cssColorIn("black")) : cssColorIn(fill);
}

/** Words in a `border` that say how it is drawn, not its colour. */
const BORDER_WORDS = new Set([
	"none",
	"hidden",
	"dotted",
	"dashed",
	"solid",
	"double",
	"groove",
	"ridge",
	"inset",
	"outset",
	"thin",
	"medium",
	"thick",
]);

/**
 * A drawn box's stroke: a shape's `stroke` and `stroke-width`, or, for a box
 * that is no shape, its style's `border`, its width in pixels and its colour,
 * a pixel wide when it gives none.
 */
function strokeOfBox(element: ElementInPage): Stroke | null {
	const shape = shapeOf(element);
	if (shape) {
		return strokeIn({
			color: cssColorIn(paintOf(shape.element, "stroke")),
			width: pixelsIn(paintOf(shape.element, "stroke-width")) ?? 1,
		});
	}
	const border = styleProperty(element, "border") ?? "";
	const words = border.match(/[a-z-]+\([^)]*\)|\S+/gi) ?? [];
	const width = words.map(pixelsIn).find((each) => each !== undefined);
	const color = words.find((word) => !BORDER_WORDS.has(word.toLowerCase()) && cssColorIn(word));
	return strokeIn({
		color: cssColorIn(color ?? styleProperty(element, "border-color")),
		width: width ?? pixelsIn(styleProperty(element, "border-width")) ?? 1,
	});
}

/** A drawn box's padding, as its style's `padding` gives it in one to four lengths in pixels. */
function paddingOfBox(element: StyledElement): BoxPadding | null {
	const lengths = (styleProperty(element, "padding") ?? "").trim().split(/\s+/).map(pixelsIn);
	if (lengths.length > 4 || lengths.some((length) => length === undefined)) return null;
	const [top, right = top, bottom = top, left = right] = lengths;
	return paddingIn({ top, right, bottom, left });
}

/** A rotation in degrees, as `rotate(15deg)` or `15deg` says it. */
const DEGREES = /^\s*(?:rotate\(\s*)?([+-]?(?:\d+\.?\d*|\.\d+))(?:deg)?\s*\)?\s*$/i;

/** A drawn box's rotation, as its style's `transform` or `rotate` gives it in degrees. */
function rotationOfBox(element: StyledElement): number | null {
	const transform = /rotate\([^)]*\)/i.exec(styleProperty(element, "transform") ?? "")?.[0];
	const [, degrees] = DEGREES.exec(transform ?? styleProperty(element, "rotate") ?? "") ?? [];
	const rotation = Number(degrees);
	return degrees !== undefined && Number.isFinite(rotation) ? rotation : null;
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
export type NewBoxAttributes = Pick<BoxAttributes, "frame"> & Partial<BoxAttributes>;

/**
 * A new box of `schema` drawn as `attributes` say, its other attributes at
 * their defaults, holding `content`: an empty paragraph when that is nothing.
 * Throws a `RangeError` when a box can't hold `content`, as text, which goes
 * in a paragraph.
 */
export function newBox(
	schema: Schema,
	attributes: NewBoxAttributes,
	content: readonly Node[] | Fragment,
): Node {
	const box = nodeType(schema, SLIDE_BOX).createAndFill(
		{ ...DEFAULT_BOX_ATTRIBUTES, ...attributes },
		Fragment.from(content as Node[] | Fragment),
	);
	if (!box) throw new RangeError("A slide's box holds blocks, which this content is not");
	return box;
}

/**
 * `change` with the box starting at `boxPos` drawn as `attributes` say, its
 * other attributes as they were. Throws a `RangeError` when no box starts at
 * `boxPos`.
 */
export function setBoxAttributes<T extends Transform>(
	change: T,
	boxPos: number,
	attributes: Partial<BoxAttributes>,
): T {
	if (change.doc.nodeAt(boxPos)?.type.name !== SLIDE_BOX) {
		throw new RangeError(`No slide's box starts at ${boxPos}`);
	}
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) change.setNodeAttribute(boxPos, name, value);
	}
	return change;
}

/** The level of a slide's title: the title slide's is the deck's own, `#`, and every other's `##`. */
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

/** `box` placed where `template` places a box, holding `content`: `box` itself when it is already. */
function placedByTemplate(box: Node, template: TemplateBox, content: Fragment): Node {
	const placed = box.type.create({ ...box.attrs, ...placedBy(template) }, content, box.marks);
	return placed.eq(box) ? box : placed;
}

/**
 * A new slide of `layout`, as the editor adds one: a box for each its
 * template places (`SLIDE_TEMPLATES`), where it places it, holding what a box
 * of its role starts with (`startingContent`), and empty notes.
 */
export function newSlide(schema: Schema, layout: SlideLayout): Node {
	const boxes = (SLIDE_TEMPLATES[layout] as readonly TemplateBox[]).map((template) =>
		newBox(schema, placedBy(template), [startingContent(schema, layout, template.role)]),
	);
	return nodeType(schema, SLIDE).create({ layout }, [
		nodeType(schema, SLIDE_BODY).create(null, boxes),
		nodeType(schema, SPEAKER_NOTES).create(null, nodeType(schema, "paragraph").create()),
	]);
}

/** A box of the slide, the blocks it holds or is to hold, and its place among the slide's boxes. */
interface Moving {
	/** The box and its index in the slide's body, or none, for blocks that come from part of a box. */
	host: { box: Node; index: number } | undefined;
	blocks: readonly Node[];
}

/**
 * `slide` laid out by `layout`, as a change of a slide's layout lays it out,
 * whoever makes it, having lost nothing:
 *
 * - The first box of each role the new layout places goes where its template
 *   places it (`placedBy`), holding what it holds.
 * - The other boxes with a role, as a left column on a slide becoming a
 *   bulleted one, go, in order, to the new layout's roles no box has yet, one
 *   to each, those past the last joining it, after what it holds. A box
 *   holding nothing gives nothing but keeps its place, so a right column
 *   stays the right one; but a label holding nothing goes, as no layout but a
 *   section break's has one, and a label is never given another box's blocks.
 *   With every role taken, they join the new layout's last box, as a section
 *   break's title takes what was under a slide's title. Leaving a section
 *   break, its title keeps only the heading it starts with, and what follows
 *   goes on as another box would. A layout that places no boxes, `blank`,
 *   leaves them where they are.
 * - Each role the new layout places that no box takes is added, as a new
 *   slide's box (`newSlide`), over the others.
 * - Boxes with no role are left exactly as they are.
 *
 * A box left holding nothing holds what a new box of its role does. The
 * boxes keep their order, but for those added. `slide` itself when it is laid
 * out by `layout` already.
 */
export function laidOutAnew(slide: Node, layout: SlideLayout): Node {
	const schema = slide.type.schema;
	const leavingSection = layoutOf(slide) === "section" && layout !== "section";
	const templates = SLIDE_TEMPLATES[layout] as readonly TemplateBox[];
	const roles = templates.map(({ role }) => role);
	const claimed = new Map<BoxRole, Moving>();
	const others: Moving[] = [];
	const gone = new Set<number>();
	bodyOf(slide).forEach((box, _offset, index) => {
		const { role } = boxAttributesOf(box);
		const blocks = box.content.content;
		if (role === null) return;
		if (roles.includes(role) && !claimed.has(role)) {
			const firstHeading = blocks[0]?.type.name === "heading" ? blocks.slice(0, 1) : [];
			const kept = leavingSection && role === "title" ? firstHeading : blocks;
			claimed.set(role, { host: { box, index }, blocks: kept });
			if (blocks.length > kept.length) {
				others.push({ host: undefined, blocks: blocks.slice(kept.length) });
			}
			return;
		}
		if (role === "label" && holdsNothing(box) && roles.length > 0) {
			gone.add(index);
			return;
		}
		others.push({ host: { box, index }, blocks });
	});
	const receiving = roles.filter((role) => role !== "label");
	const left = receiving.filter((role) => !claimed.has(role));
	const joining = new Map<BoxRole, Moving>();
	others.forEach((other, index) => {
		const role = left[Math.min(index, left.length - 1)] ?? receiving.at(-1);
		if (!role) return;
		const already = joining.get(role);
		const given = other.blocks.every(holdsNothing) ? [] : other.blocks;
		joining.set(role, {
			host: already?.host ?? other.host,
			blocks: [...(already?.blocks ?? []), ...given],
		});
		if (other.host && already?.host) gone.add(other.host.index);
	});
	const placed = new Map<number, Node>();
	const added: Node[] = [];
	for (const template of templates) {
		const keeps = claimed.get(template.role);
		const joins = joining.get(template.role);
		const blocks = [...(keeps?.blocks ?? []), ...(joins?.blocks ?? [])];
		const content = Fragment.fromArray(
			blocks.length > 0 ? blocks : [startingContent(schema, layout, template.role)],
		);
		const host = keeps?.host ?? joins?.host;
		if (keeps?.host && joins?.host) gone.add(joins.host.index);
		if (host) placed.set(host.index, placedByTemplate(host.box, template, content));
		else added.push(newBox(schema, placedBy(template), content));
	}
	const boxes = bodyOf(slide).children.flatMap((box, index) =>
		gone.has(index) ? [] : [placed.get(index) ?? box],
	);
	return withBoxes(slide, { layout }, [...boxes, ...added]);
}

/**
 * `slide` with each box of a role its layout places put back where the
 * layout's template places it (`placedBy`), as the layout's "Reset layout"
 * puts it: every other box, and what each holds, as it is. `slide` itself
 * when every such box is there already.
 */
export function resetToTemplate(slide: Node): Node {
	const layout = layoutOf(slide);
	const boxes = bodyOf(slide).children.map((box) => {
		const { role } = boxAttributesOf(box);
		const template = role && templateBoxOf(layout, role);
		return template ? placedByTemplate(box, template, box.content) : box;
	});
	return withBoxes(slide, {}, boxes);
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
