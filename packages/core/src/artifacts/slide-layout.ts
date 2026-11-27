import {
	bodyOf,
	boxAttributesOf,
	layoutOf,
	SLIDE_TEXT_STEPS,
} from "@sugabots/contracts/live-slides";
import type { BoxRole, VerticalAlign } from "@sugabots/contracts/slide-box";
import {
	type Frame,
	roomBottom,
	SLIDE_HEIGHT,
	SLIDE_UNIT,
	SLIDE_WIDTH,
} from "@sugabots/contracts/slide-geometry";
import type { SlideLayout } from "@sugabots/contracts/slide-layouts";
import type { Mark, Node } from "@tiptap/pm/model";
import { metricsOf, type TextType } from "./pdf-fonts.ts";
import {
	ACCENT,
	accentBarOver,
	alignedOffset,
	BLOCK_QUOTE_LOOK,
	boxLookOf,
	CODE_LOOK,
	COLUMN_LOOK,
	cellInsetOf,
	contentAreaOf,
	fittedImage,
	HIGHLIGHT,
	hasAccentBar,
	IMAGE_WORDS_LOOK,
	imageFillingBox,
	imageFitOf,
	imageRadiusOf,
	LINK_UNDERLINE_OFFSET,
	LIST_LOOK,
	lineHeightOf,
	linkInFile,
	ownTextStyleOf,
	paintOf,
	QUOTE_LOOK,
	RULE,
	RULE_THICKNESS,
	SCRIPT,
	SECTION_BAR,
	type ShapeLook,
	shapeLookOf,
	TABLE_LOOK,
	TEXT,
	type TextAlign,
	type TextLook,
	TINT,
	textAlignOf,
} from "./slide-design.ts";

/*
 * A deck's slides laid out as the app's slide styles lay them out
 * (`slide-design.ts`), measured in its fonts: each box at its frame, in the
 * order the slide holds them, what it holds within its padding and where its
 * vertical alignment sits it, and the slide's text at the largest of
 * `SLIDE_TEXT_STEPS` at which every box's fits, as in the app. The PDF draws a
 * slide where it is laid out (`pdf.ts`), and the PowerPoint file sets a
 * slide's text at the step it is laid out at, measuring what it stacks in a
 * box as it is laid out here (`powerpoint.ts`).
 *
 * Everything is laid out first, measured, and drawn after with a pen where it
 * was laid out, so a slide's text can be laid out again at a smaller step
 * before anything is drawn, and measured without being drawn at all.
 *
 * A slide is cut off at its edges, as the app cuts it off; the pen cuts off
 * what is drawn past them (`Pen.clipped`). What is stacked one thing under
 * another leaves out what starts where it is cut off (`stacked`), numbers,
 * rules and links with it, and is laid out only as far as it takes to know
 * the box can't fit, or as far as the slide shows, so a slide that runs over
 * by any amount costs no more than one that runs over a little.
 */

/** How a stretch of text is set, and its colour. */
export interface Type extends TextType {
	color: string;
	/** How opaque it is, from 0 to 1: wholly, unless its own colour says otherwise. */
	opacity?: number;
}

/** A width and height, in points. */
export interface Size {
	width: number;
	height: number;
}

export interface Box extends Size {
	x: number;
	y: number;
}

/** What a slide is measured with: its text, in the app's fonts, and its images. */
export interface Measure {
	widthOf(type: Type, text: string): number;
	/**
	 * The size of the image the deck keeps at `address`, as it is drawn upright:
	 * `undefined` for one the file doesn't draw. It is asked the first time a
	 * slide's layout reaches the image.
	 */
	imageSizeAt(address: string): Size | undefined;
}

/** What draws a slide where it was laid out. */
export interface Pen {
	/** Draws `text` with its baseline at `baseline`. */
	text(type: Type, text: string, x: number, baseline: number): void;
	fill(box: Box, look: { color: string; opacity?: number; radius?: number }): void;
	/** A dashed outline just inside `box`. */
	dashed(box: Box, look: { color: string; radius: number }): void;
	/** A box's own shape at `frame`, as `look` says: its path, in the frame's own points, or the frame's rectangle, its outline within the frame. */
	shape(frame: Frame, look: ShapeLook): void;
	/**
	 * The image the deck keeps at `address`, one `Measure.imageSizeAt` gives a
	 * size for, drawn upright across `box` and cut off at `clip`, whose corners
	 * are rounded by `radius`.
	 */
	image(address: string, box: Box, clip: Box, radius: number): void;
	/** Draws what `draw` draws turned `degrees` clockwise about the middle of `frame`. */
	rotated(frame: Frame, degrees: number, draw: () => void): void;
	/** Draws what `draw` draws, cut off at the edges of `box`. */
	clipped(box: Box, draw: () => void): void;
	/**
	 * Whether what is drawn from `y` down is cut off whole: `y` is at or past
	 * the foot of a box drawing is cut off at (`clipped`). Never, within what is
	 * drawn turned (`rotated`), where `y` is no longer down the slide.
	 */
	cutsOffFrom(y: number): boolean;
	/** A link over `box`, as far as what it is drawn within shows. */
	link(box: Box, url: string): void;
}

/** What is inherited down a box's blocks, as CSS inherits it. */
interface Setting {
	measure: Measure;
	/** The slide's unit at the step its text is drawn at, in points. */
	unit: number;
	heading: TextLook;
	/** Paragraphs' look; its line height is every block's but a heading's. */
	text: TextLook;
	/** The weight of what isn't a paragraph or heading: a list's bullets and numbers, and code. */
	weight: number;
	/** The space after each character of what isn't a heading, in points. */
	tracking: number;
	/** The size the blocks in it are sized against, in points: what a quote's rule is in ems of. */
	fontSize: number;
	/** Between a list's items, in ems of their text. */
	listGap: number;
	/** Whether each heading has a rule under it, as in the columns layout's columns. */
	ruledHeadings: boolean;
	/** Whether headings' lines are made as even as they can be, as in the title and image layouts. */
	balancedHeadings: boolean;
	balancedText: boolean;
	/** Whether a quote is the slide's large quote, as every one in the quote layout is. */
	quoteLayout: boolean;
	/** An image's corners, in ems of its text. */
	imageRadius: number;
	/** Whether its tables' cells are padded tightly (`cellInsetOf`). */
	tightCells: boolean;
}

/** Something laid out, to draw with its top left at a point. */
interface Laid {
	height: number;
	/** How wide what it draws is, at most the width it was laid out across. */
	width: number;
	/** How far below its top its first line's baseline is: `undefined` without lines. */
	baseline: number | undefined;
	draw: (pen: Pen, x: number, y: number) => void;
}

/**
 * Laying out something under the room left for it, in points: how far below
 * its top it may reach and still be shown, or fit. Past that, nothing more of
 * it is laid out, and it is taken to reach past the room.
 */
type LayOut = (room: number) => Laid;

const NOTHING: Laid = { height: 0, width: 0, baseline: undefined, draw: () => {} };

/** A slide laid out: the step its text is drawn at, whether it fits at it, and drawing it. */
export interface ArrangedSlide {
	/** One of `SLIDE_TEXT_STEPS`. */
	step: number;
	fits: boolean;
	/** Draws the slide's boxes, in order, cut off at its edges. */
	draw: (pen: Pen) => void;
}

/** How far past the room it has what a box holds may reach and still fit, as the app allows a pixel for rounding. */
const FIT_ALLOWANCE = 1;

/** Where a slide is cut off: at its edges. */
const WHOLE_SLIDE: Box = { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT };

/**
 * `slide`'s boxes laid out at the largest step at which each that holds text
 * the slide styles size fits (`laidBox`), or the smallest. A box whose text
 * all has a size of its own is drawn at that size wherever it reaches, as no
 * step changes it, so only the others are measured, as the app measures them.
 */
export function arrangedSlide(slide: Node, measure: Measure): ArrangedSlide {
	const layout = layoutOf(slide);
	const boxes = bodyOf(slide).children;
	const frames = boxes.map((box) => boxAttributesOf(box).frame);
	const stepping = boxes.map(holdsSteppedText);
	const atStep = (step: number): ArrangedSlide => {
		const laid = boxes.map((box, index) =>
			laidBox(box, layout, measure, step, roomBottom(frames, index)),
		);
		return {
			step,
			fits: laid.every((box, index) => !stepping[index] || box.fits),
			draw: (pen) =>
				pen.clipped(WHOLE_SLIDE, () => {
					for (const box of laid) box.draw(pen);
				}),
		};
	};
	const [largest, ...smaller] = SLIDE_TEXT_STEPS;
	let arrangement = atStep(largest);
	for (const step of smaller) {
		if (arrangement.fits) break;
		arrangement = atStep(step);
	}
	return arrangement;
}

/** Whether `box` holds text the slide styles size, which steps down to fit: text with no size of its own. */
function holdsSteppedText(box: Node): boolean {
	let stepped = false;
	box.descendants((node) => {
		stepped ||= node.isText && ownTextStyleOf(node.marks).fontSize === undefined;
		return !stepped;
	});
	return stepped;
}

/**
 * The size a paragraph or heading, `line`, is set at when every stretch of
 * its text has a size of its own (`ownTextStyleOf`): the largest of them, in
 * points, as the app sets the line's own element, so its lines are spaced as
 * their text is sized rather than as the slide styles would size it.
 * `undefined` for a line holding no text, or any text the slide styles size.
 */
function ownLineSizeOf(line: Node): number | undefined {
	let largest: number | undefined;
	let own = true;
	line.forEach((inline) => {
		if (!inline.isText) return;
		const size = ownTextStyleOf(inline.marks).fontSize;
		if (size === undefined) own = false;
		else largest = Math.max(largest ?? 0, size);
	});
	return own ? largest : undefined;
}

/** A box laid out at its frame: whether what it holds fits the room it has, and drawing it. */
interface LaidBox {
	fits: boolean;
	draw: (pen: Pen) => void;
}

/**
 * `box`, one of a slide of `layout`'s, laid out at its frame with its text at
 * `step`: what it holds across its content area (`contentAreaOf`), as far
 * apart as its role sets its blocks, up and down the area as its vertical
 * alignment sits it, or, for an image filling the box, the image over the
 * area (`filledArea`); and over a section break's label, the accent bar. All
 * of it turns with the box.
 *
 * It fits when what it holds reaches no lower than `room`, how far down the
 * slide it may reach (`roomBottom`), give or take the pixel the app allows.
 * What rises above its area, as what is set at its foot may, the app doesn't
 * measure.
 */
function laidBox(
	box: Node,
	layout: SlideLayout,
	measure: Measure,
	step: number,
	room: number,
): LaidBox {
	const attributes = boxAttributesOf(box);
	const { frame, role, verticalAlign, rotation } = attributes;
	const area = contentAreaOf(attributes);
	const setting = settingOf({ layout, role, step, width: area.width }, measure);
	const laid =
		filledArea(box, area, layout, setting) ??
		stackedWithin(
			layOutsOf(box.children, setting, area.width),
			boxLookOf(layout, role).gap * setting.unit,
			heightToLayOut(area, verticalAlign, room),
		);
	const top = area.y + alignedOffset(verticalAlign, area.height, laid.height);
	const bar = hasAccentBar(layout, role) ? accentBarOver(frame, setting.unit) : undefined;
	const shape = shapeLookOf(attributes);
	return {
		fits: top + laid.height <= room + FIT_ALLOWANCE,
		draw: (pen) =>
			pen.rotated(frame, rotation, () => {
				pen.shape(frame, shape);
				if (bar) pen.fill(bar, { color: ACCENT, radius: SECTION_BAR.radius * setting.unit });
				laid.draw(pen, area.x, top);
			}),
	};
}

/**
 * The image `box` holds alone filling its content `area` (`imageFillingBox`),
 * as tall as the area: drawn over it as `imageFitOf` says, cut to the area,
 * whose corners it takes but on a blank slide. `undefined` for a box holding
 * anything else, or an image the file doesn't draw, which is in the text as
 * its words.
 */
function filledArea(
	box: Node,
	area: Frame,
	layout: SlideLayout,
	setting: Setting,
): Laid | undefined {
	const address: unknown = imageFillingBox(box)?.attrs.src;
	const natural = typeof address === "string" ? setting.measure.imageSizeAt(address) : undefined;
	if (typeof address !== "string" || !natural) return undefined;
	const fit = imageFitOf(layout);
	const radius = fit === "cover" ? 0 : setting.imageRadius * paragraphType(setting).type.size;
	return {
		height: area.height,
		width: area.width,
		baseline: undefined,
		draw: (pen, x, y) => {
			const within = { x, y, width: area.width, height: area.height };
			pen.image(address, fittedImage(natural, within, fit), within, radius);
		},
	};
}

/**
 * How tall what a box holds is laid out, at most, in its content `area`, as
 * `align` sits it there: as tall as it may be and still fit, `room` being how
 * far down the slide it may reach, or as the slide shows it, whichever is
 * taller. Past that, it doesn't fit, and is drawn only as far as it is laid
 * out.
 */
function heightToLayOut(area: Frame, align: VerticalAlign, room: number): number {
	const reach = Math.max(SLIDE_HEIGHT, room);
	const highest = Math.min(area.y, 0);
	const bottom = area.y + area.height;
	const middle = area.y + area.height / 2;
	const height =
		align === "top"
			? reach - area.y
			: align === "middle"
				? 2 * Math.max(middle - highest, reach - middle)
				: bottom - highest;
	return height + FIT_ALLOWANCE;
}

/** Where on a slide blocks are set: in a box of which role on a slide of which layout, at which step, and across how much. */
export interface Placing {
	layout: SlideLayout;
	role: BoxRole | null;
	/** One of `SLIDE_TEXT_STEPS`. */
	step: number;
	/** The width of the box's content area (`contentAreaOf`), in points. */
	width: number;
}

/** How far down blocks are measured, in points: past a slide's height, they are taken to be that tall and more. */
const MOST_MEASURED = SLIDE_HEIGHT + FIT_ALLOWANCE;

/** How tall `blocks` are, one under another, set as `placing` says, in points. */
export function heightOfBlocks(
	blocks: readonly Node[],
	placing: Placing,
	measure: Measure,
): number {
	const setting = settingOf(placing, measure);
	const { gap } = boxLookOf(placing.layout, placing.role);
	return stackedWithin(layOutsOf(blocks, setting, placing.width), gap * setting.unit, MOST_MEASURED)
		.height;
}

/**
 * How tall each of `table`'s rows is, set as `placing` says, in points: its
 * cells' padding and text, and the rule under it. Rows past a slide's height
 * aren't measured.
 */
export function rowHeightsOf(table: Node, placing: Placing, measure: Measure): number[] {
	const setting = settingOf(placing, measure);
	return tableRows(table, setting, placing.width, MOST_MEASURED).map((row) => row.height);
}

/** What the blocks set as `placing` says inherit. */
function settingOf({ layout, role, step }: Placing, measure: Measure): Setting {
	const look = boxLookOf(layout, role);
	const unit = step * SLIDE_UNIT;
	return {
		measure,
		unit,
		heading: look.heading,
		text: look.text,
		weight: REGULAR,
		tracking: 0,
		fontSize: unit,
		listGap: look.listGap,
		ruledHeadings: look.ruledHeadings,
		balancedHeadings: layout === "title" || layout === "image",
		balancedText: false,
		quoteLayout: layout === "quote",
		imageRadius: imageRadiusOf(layout, role),
		tightCells: look.tightCells,
	};
}

const REGULAR = 400;

const layOutsOf = (blocks: readonly Node[], setting: Setting, width: number): LayOut[] =>
	blocks.map(
		(block): LayOut =>
			(room) =>
				laidBlock(block, setting, width, room),
	);

/**
 * `items` one under another, `gap` apart, each at the left. Drawn, those that
 * start where the pen cuts off what it draws (`Pen.cutsOffFrom`) are left out.
 */
function stacked(items: readonly Laid[], gap: number): Laid {
	if (items.length === 0) return NOTHING;
	const tops: number[] = [];
	let height = 0;
	let widest = 0;
	for (const [index, item] of items.entries()) {
		if (index > 0) height += gap;
		tops.push(height);
		height += item.height;
		widest = Math.max(widest, item.width);
	}
	const firstWithLines = items.findIndex((item) => item.baseline !== undefined);
	const first = items[firstWithLines];
	return {
		height,
		width: widest,
		baseline:
			first?.baseline === undefined ? undefined : (tops[firstWithLines] ?? 0) + first.baseline,
		draw: (pen, x, y) => {
			for (const [index, item] of items.entries()) {
				const top = y + (tops[index] ?? 0);
				if (pen.cutsOffFrom(top)) return;
				item.draw(pen, x, top);
			}
		},
	};
}

/**
 * What `layOuts` lay out, one under another, `gap` apart, as `stacked` stacks
 * them, as far as `room` reaches: one that would start past it isn't laid
 * out, and the stack is taken to reach to where it would have started.
 */
function stackedWithin(layOuts: readonly LayOut[], gap: number, room: number): Laid {
	const items: Laid[] = [];
	let height = 0;
	for (const layOut of layOuts) {
		const top = items.length === 0 ? 0 : height + gap;
		if (top > room) return { ...stacked(items, gap), height: top };
		const item = layOut(room - top);
		items.push(item);
		height = top + item.height;
	}
	return stacked(items, gap);
}

/*
 * Blocks.
 */

function laidBlock(block: Node, setting: Setting, width: number, room: number): Laid {
	switch (block.type.name) {
		case "paragraph":
			return laidTextblock(
				block,
				paragraphType(setting),
				setting,
				width,
				setting.balancedText,
				room,
			);
		case "heading":
			return laidHeading(block, setting, width, room);
		case "bulletList":
		case "orderedList":
			return laidList(block, setting, width, room);
		case "blockquote":
			return laidQuote(block, setting, width, room);
		case "codeBlock":
			return laidCode(block, setting, width, room);
		case "table":
			return laidTable(block, setting, width, room);
		default:
			return block.isTextblock
				? laidTextblock(block, paragraphType(setting), setting, width, false, room)
				: stackedWithin(layOutsOf(block.children, setting, width), 0, room);
	}
}

/** A block's type, with the line height its lines take. */
interface BlockType {
	type: Type;
	lineHeight: number;
}

const paragraphType = ({ text, unit, tracking }: Setting): BlockType => ({
	type: {
		face: { family: "sans", weight: text.weight, italic: false },
		size: text.size * unit,
		color: text.color,
		tracking,
	},
	lineHeight: text.lineHeight,
});

/** Headings up to the third take the part's heading look; those below are the size and weight of what is around them. */
function laidHeading(heading: Node, setting: Setting, width: number, room: number): Laid {
	const level = Number(heading.attrs.level) || 1;
	if (level > 3) {
		const around: BlockType = {
			type: {
				face: { family: "sans", weight: setting.weight, italic: false },
				size: setting.fontSize,
				color: TEXT,
				tracking: setting.tracking,
			},
			lineHeight: setting.text.lineHeight,
		};
		return laidTextblock(heading, around, setting, width, false, room);
	}
	const look = setting.heading;
	// Its letter spacing and the rule under it are in ems of the size it is set at.
	const size = ownLineSizeOf(heading) ?? look.size * setting.unit;
	const type: BlockType = {
		type: {
			face: { family: "sans", weight: look.weight, italic: false },
			size,
			color: TEXT,
			tracking: look.tracking * size,
		},
		lineHeight: look.lineHeight,
	};
	const text = laidTextblock(heading, type, setting, width, setting.balancedHeadings, room);
	if (!setting.ruledHeadings) return text;
	const ruleTop = text.height + COLUMN_LOOK.headingRuleGap * size;
	return {
		height: ruleTop + RULE_THICKNESS,
		width,
		baseline: text.baseline,
		draw: (pen, x, y) => {
			text.draw(pen, x, y);
			pen.fill({ x, y: y + ruleTop, width, height: RULE_THICKNESS }, { color: RULE });
		},
	};
}

/**
 * A paragraph or heading: its lines, at its own line height and alignment
 * where it sets them, and set at the size of its text when all of it has a
 * size of its own (`ownLineSizeOf`); and each image in it on its own, as the
 * app draws an image as a block of its own between the words around it.
 */
function laidTextblock(
	block: Node,
	blockType: BlockType,
	setting: Setting,
	width: number,
	balanced: boolean,
	room: number,
): Laid {
	const size = ownLineSizeOf(block) ?? blockType.type.size;
	const lined: BlockType = {
		type: { ...blockType.type, size },
		lineHeight: lineHeightOf(block) ?? blockType.lineHeight,
	};
	const align = textAlignOf(block) ?? "left";
	const parts: LayOut[] = [];
	let words: Node[] = [];
	const endWords = () => {
		if (words.length > 0) {
			const inlines = inlinesOf(words, lined.type);
			parts.push((partRoom) =>
				laidLines(inlines, lined, setting.measure, { width, align, balanced }, partRoom),
			);
		}
		words = [];
	};
	for (const child of block.children) {
		if (child.type.name !== "image") {
			words.push(child);
			continue;
		}
		endWords();
		parts.push(() => laidImage(child, lined, setting, width));
	}
	endWords();
	return stackedWithin(parts, 0, room);
}

/** An image the deck keeps, as large as it is but no wider than `width`, or its words when it isn't drawn. */
function laidImage(image: Node, around: BlockType, setting: Setting, width: number): Laid {
	const { measure } = setting;
	const address: unknown = image.attrs.src;
	const natural = typeof address === "string" ? measure.imageSizeAt(address) : undefined;
	if (typeof address !== "string" || !natural) {
		return laidImageWords(String(image.attrs.alt ?? ""), around, measure, width);
	}
	const scale = Math.min(1, width / natural.width);
	const box = { width: natural.width * scale, height: natural.height * scale };
	const link = linkInFile(image.attrs.link);
	return {
		...box,
		baseline: undefined,
		draw: (pen, x, y) => {
			const at = { x, y, ...box };
			pen.image(address, at, at, setting.imageRadius * around.type.size);
			if (link) pen.link(at, link);
		},
	};
}

/** An image's words, in a dashed box across the width, as the app draws an image without its picture as a block. */
function laidImageWords(words: string, around: BlockType, measure: Measure, width: number): Laid {
	const { padding, radius, color, border } = IMAGE_WORDS_LOOK;
	const inset = { x: padding.x + 1, y: padding.y + 1 };
	const type: BlockType = { ...around, type: { ...around.type, color, opacity: 1 } };
	const lines = laidLines(
		withWhiteSpaceCollapsed([runOf(words, type.type, [], [])]),
		type,
		measure,
		{ width: Math.max(0, width - 2 * inset.x), align: "left", balanced: false },
		MOST_MEASURED,
	);
	const box = { width, height: Math.max(around.type.size, lines.height + 2 * inset.y) };
	return {
		...box,
		baseline: lines.baseline === undefined ? undefined : inset.y + lines.baseline,
		draw: (pen, x, y) => {
			pen.dashed({ x, y, ...box }, { color: border, radius });
			lines.draw(pen, x + inset.x, y + inset.y);
		},
	};
}

/** A list: each item's blocks indented, its bullet or number before its first line. */
function laidList(list: Node, setting: Setting, width: number, room: number): Laid {
	const fontSize = setting.text.size * setting.unit;
	const indent = LIST_LOOK.indent * fontSize;
	const itemSetting = { ...setting, fontSize };
	const markerType: Type = {
		face: { family: "sans", weight: setting.weight, italic: false },
		size: fontSize,
		color: TEXT,
		tracking: setting.tracking,
		features: ["tnum"],
	};
	const strut = lineBoxOf([markerType], setting.text.lineHeight);
	const start = Number(list.attrs.start) || 1;
	const drawMarker =
		list.type.name === "orderedList"
			? (pen: Pen, index: number, x: number, baseline: number) => {
					const number = `${start + index}.`;
					const before = setting.measure.widthOf(markerType, `${number} `);
					pen.text(markerType, number, x - before, baseline);
				}
			: (pen: Pen, _index: number, x: number, baseline: number) => {
					const disc = discBefore(fontSize);
					pen.fill(
						{ x: x + disc.x, y: baseline + disc.y, width: disc.size, height: disc.size },
						{ color: TEXT, radius: disc.size / 2 },
					);
				};
	const items = list.children.map(
		(item, index): LayOut =>
			(itemRoom) => {
				const content = laidItem(item, itemSetting, width - indent, itemRoom);
				const baseline = content.baseline ?? strut.above;
				return {
					height: content.height,
					width,
					baseline,
					draw: (pen, x, y) => {
						drawMarker(pen, index, x + indent, y + baseline);
						content.draw(pen, x + indent, y);
					},
				};
			},
	);
	return stackedWithin(items, setting.listGap * fontSize, room);
}

/** The space Chrome leaves between a bullet and its item's text, in points: a pixel on the slide 960 wide. */
const BULLET_PADDING = 7;

/**
 * A list's bullet as Chrome draws one for text of `size`, relative to the
 * start of the item's text and its first baseline: a disc a third of the
 * font's ascent across, centred on its lower case, set off by the ascent's
 * two thirds and a few pixels.
 */
function discBefore(size: number): { x: number; y: number; size: number } {
	const ascent = Math.round(metricsOf("sans").ascent * size);
	const offset = Math.floor((ascent * 2) / 3);
	return {
		x: -(offset + BULLET_PADDING),
		y: -ascent + Math.floor((3 * (ascent - offset)) / 2),
		size: Math.floor((offset + 1) / 2),
	};
}

/** A list item's blocks, a list in it a little below what is above it. */
function laidItem(item: Node, setting: Setting, width: number, room: number): Laid {
	const parts = item.children.map((child, index): LayOut => {
		if (index === 0 || !isList(child)) {
			return (partRoom) => laidBlock(child, setting, width, partRoom);
		}
		const above = LIST_LOOK.nestedGap * setting.fontSize;
		return (partRoom) => {
			const laid = laidBlock(child, setting, width, partRoom - above);
			return {
				...laid,
				height: laid.height + above,
				baseline: laid.baseline === undefined ? undefined : laid.baseline + above,
				draw: (pen: Pen, x: number, y: number) => laid.draw(pen, x, y + above),
			};
		};
	});
	return stackedWithin(parts, 0, room);
}

const isList = (block: Node) =>
	block.type.name === "bulletList" || block.type.name === "orderedList";

/** A quote: its blocks softer behind a rule, or, in the quote layout, the slide's large quote. */
function laidQuote(quote: Node, setting: Setting, width: number, room: number): Laid {
	if (setting.quoteLayout) {
		const quoteSetting: Setting = {
			...setting,
			text: QUOTE_LOOK,
			weight: QUOTE_LOOK.weight,
			tracking: QUOTE_LOOK.tracking * QUOTE_LOOK.size * setting.unit,
			balancedText: true,
		};
		return stackedWithin(layOutsOf(quote.children, quoteSetting, width), 0, room);
	}
	const rule = BLOCK_QUOTE_LOOK.rule * setting.fontSize;
	const indent = rule + BLOCK_QUOTE_LOOK.padding * setting.fontSize;
	const inner: Setting = { ...setting, text: { ...setting.text, color: BLOCK_QUOTE_LOOK.color } };
	const content = stackedWithin(layOutsOf(quote.children, inner, width - indent), 0, room);
	return {
		height: content.height,
		width: indent + content.width,
		baseline: content.baseline,
		draw: (pen, x, y) => {
			pen.fill({ x, y, width: rule, height: content.height }, { color: RULE });
			content.draw(pen, x + indent, y);
		},
	};
}

/** The spaces a tab takes in code. */
const TAB_SIZE = 4;

/** The characters that end a line of code, as a browser ends one in preformatted text. */
const CODE_LINE_ENDS = /[\n\u2028\u2029]/;

/** A code block: its lines as they are, unwrapped, on a tint, cut off at its edge. */
function laidCode(block: Node, setting: Setting, width: number, room: number): Laid {
	const size = CODE_LOOK.blockScale * setting.text.size * setting.unit;
	const type: Type = {
		face: { family: "mono", weight: setting.weight, italic: false },
		size,
		color: TEXT,
		tracking: setting.tracking,
	};
	const padding = { x: CODE_LOOK.blockPadding.x * size, y: CODE_LOOK.blockPadding.y * size };
	const text = block.textContent;
	const box = lineBoxOf([type], setting.text.lineHeight);
	const lineHeight = box.above + box.below;
	const lines = stackedWithin(
		(text === "" ? [] : text.replace(/\n$/, "").split(CODE_LINE_ENDS)).map(
			(line): LayOut =>
				() => ({
					height: lineHeight,
					width,
					baseline: box.above,
					draw: (pen, x, y) => pen.text(type, withTabsAsSpaces(line), x, y + box.above),
				}),
		),
		0,
		room - padding.y,
	);
	const height = lines.height + 2 * padding.y;
	return {
		height,
		width,
		baseline: lines.baseline === undefined ? undefined : padding.y + lines.baseline,
		draw: (pen, x, y) => {
			pen.fill({ x, y, width, height }, { color: TINT, radius: CODE_LOOK.blockRadius * size });
			pen.clipped({ x, y, width, height }, () => lines.draw(pen, x + padding.x, y + padding.y));
		},
	};
}

function withTabsAsSpaces(line: string): string {
	let column = 0;
	let spaced = "";
	for (const character of line) {
		if (character === "\t") {
			const spaces = TAB_SIZE - (column % TAB_SIZE);
			spaced += " ".repeat(spaces);
			column += spaces;
		} else {
			spaced += character;
			column += 1;
		}
	}
	return spaced;
}

/** A table's row laid out: each cell's place in it and its content, and its height, the rule under it included. */
interface TableRow {
	cells: {
		header: boolean;
		x: number;
		width: number;
		inset: { x: number; y: number };
		content: Laid;
	}[];
	height: number;
}

/** A table's rows across `width`, its columns as wide as each other, as far as `room` reaches. */
function tableRows(table: Node, setting: Setting, width: number, room: number): TableRow[] {
	let columns = 1;
	for (const row of table.children) columns = Math.max(columns, spanOf(row));
	const columnWidth = width / columns;
	const fontSize = TABLE_LOOK.text.size * setting.unit;
	const rows: TableRow[] = [];
	let top = 0;
	for (const row of table.children) {
		if (top > room) break;
		let column = 0;
		const cells = row.children.map((cell, index) => {
			const header = cell.type.name === "tableHeader";
			const firstColumn = index === 0 && !header;
			const weight = header
				? TABLE_LOOK.header.weight
				: firstColumn
					? TABLE_LOOK.firstColumnWeight
					: setting.text.weight;
			const cellSetting: Setting = {
				...setting,
				fontSize,
				text: {
					...TABLE_LOOK.text,
					color: header ? TABLE_LOOK.header.color : setting.text.color,
					weight,
				},
				weight: header || firstColumn ? weight : setting.weight,
			};
			const inset = cellInsetOf(setting.tightCells, header, fontSize);
			const span = Number(cell.attrs.colspan) || 1;
			const cellWidth = span * columnWidth;
			const content = stackedWithin(
				layOutsOf(cell.children, cellSetting, cellWidth - 2 * inset.x),
				TABLE_LOOK.blockGap * fontSize,
				room - top - inset.y,
			);
			const x = column * columnWidth;
			column += span;
			return { header, x, width: cellWidth, inset, content };
		});
		let tallest = 0;
		for (const { content, inset } of cells)
			tallest = Math.max(tallest, content.height + 2 * inset.y);
		const height = tallest + RULE_THICKNESS;
		rows.push({ cells, height });
		top += height;
	}
	return rows;
}

/** A table across the width, its columns as wide as each other, its header cells on a tint, each row ruled below. */
function laidTable(table: Node, setting: Setting, width: number, room: number): Laid {
	const rows = tableRows(table, setting, width, room).map(
		(row): LayOut =>
			() => ({
				height: row.height,
				width,
				baseline: undefined,
				draw: (pen, x, y) => {
					const ruleTop = y + row.height - RULE_THICKNESS;
					for (const cell of row.cells) {
						if (cell.header) {
							pen.fill(
								{ x: x + cell.x, y, width: cell.width, height: ruleTop - y },
								{ color: TINT },
							);
						}
						cell.content.draw(pen, x + cell.x + cell.inset.x, y + cell.inset.y);
					}
					pen.fill({ x, y: ruleTop, width, height: RULE_THICKNESS }, { color: RULE });
				},
			}),
	);
	return stackedWithin(rows, 0, room);
}

function spanOf(row: Node): number {
	let span = 0;
	for (const cell of row.children) span += Number(cell.attrs.colspan) || 1;
	return span;
}

/*
 * Lines of text: a textblock's words with their marks, broken into lines as
 * a browser breaks them, at spaces, zero-width spaces and soft hyphens, and
 * within a word only where it is wider than the line.
 */

/** A stretch of a line's text in one look. */
interface Run {
	kind: "run";
	text: string;
	type: Type;
	/** How far its baseline sits above the line's, in points: below for a subscript. */
	raise: number;
	/** Whether its line makes room for it, which it doesn't for a superscript or a subscript. */
	sized: boolean;
	underline: "link" | "plain" | undefined;
	strike: boolean;
	link: string | undefined;
	/** The boxes it is drawn on, outermost first. */
	backdrops: readonly Backdrop[];
}

/** The room at either end of a box text is drawn on, which belongs to the box. */
interface Padding {
	kind: "padding";
	width: number;
	backdrops: readonly Backdrop[];
}

interface LineBreak {
	kind: "break";
}

type Inline = Run | Padding | LineBreak;

/** A box behind a stretch of text: code in a line, or highlighted text. */
interface Backdrop {
	color: string;
	opacity?: number;
	radius: number;
	/** How far it reaches above the baseline and below it, in points. */
	above: number;
	below: number;
}

/** The marks that draw a box behind their text. */
const BACKDROP_MARKS = new Set(["code", "highlight"]);

/** The characters that end a line within a paragraph, as a line break does: the line and paragraph separators. */
const LINE_SEPARATORS = /[\u2028\u2029]/;

/**
 * A textblock's inline nodes as runs of `base` with their marks, and the
 * colour and size of their own (`withOwnStyle`): each box behind a stretch of
 * them padded at its ends, and each stretch of white space one space, none at
 * a line's start.
 *
 * The app draws each mark as an element, nested in the order the schema
 * lists marks, and a mark's element goes on over the next node only while
 * every mark outside it does too, as ProseMirror's DOM serializer nests them.
 * So a highlight inside italics is a box of its own, padded at both ends.
 */
function inlinesOf(nodes: readonly Node[], base: Type): Inline[] {
	const inlines: Inline[] = [];
	const open: { mark: Mark; backdrop?: { backdrop: Backdrop; padding: number } }[] = [];
	const backdrops = () => open.flatMap((each) => (each.backdrop ? [each.backdrop.backdrop] : []));
	/** Ends the marks' elements open beyond the first `count`, the innermost first. */
	const closeTo = (count: number) => {
		while (open.length > count) {
			const closing = open.at(-1)?.backdrop;
			if (closing)
				inlines.push({ kind: "padding", width: closing.padding, backdrops: backdrops() });
			open.pop();
		}
	};
	for (const node of nodes) {
		const styled = withOwnStyle(base, node.marks);
		let kept = 0;
		while (
			kept < open.length &&
			kept < node.marks.length &&
			open[kept]?.mark.eq(node.marks[kept] as Mark)
		) {
			kept++;
		}
		closeTo(kept);
		for (const mark of node.marks.slice(kept)) {
			const backdrop = BACKDROP_MARKS.has(mark.type.name) ? backdropOf(mark, styled) : undefined;
			open.push({ mark, backdrop });
			if (backdrop)
				inlines.push({ kind: "padding", width: backdrop.padding, backdrops: backdrops() });
		}
		if (node.type.name === "hardBreak") {
			inlines.push({ kind: "break" });
			continue;
		}
		const text = node.isText ? (node.text ?? "") : node.textContent;
		for (const [index, line] of text.split(LINE_SEPARATORS).entries()) {
			if (index > 0) inlines.push({ kind: "break" });
			inlines.push(runOf(line, styled, node.marks, backdrops()));
		}
	}
	closeTo(0);
	return withWhiteSpaceCollapsed(inlines);
}

/** `base` in the colour and at the size `marks` give their text of its own, a size that never steps down. */
function withOwnStyle(base: Type, marks: readonly Mark[]): Type {
	const own = ownTextStyleOf(marks);
	const paint = paintOf(own.color ?? null);
	return {
		...base,
		size: own.fontSize ?? base.size,
		...(paint ? { color: paint.color, opacity: paint.opacity } : {}),
	};
}

function backdropOf(mark: Mark, base: Type): { backdrop: Backdrop; padding: number } {
	if (mark.type.name === "code") {
		const size = base.size * CODE_LOOK.inlineScale;
		const metrics = metricsOf("mono");
		const paddingY = CODE_LOOK.inlinePadding.y * size;
		return {
			backdrop: {
				color: TINT,
				radius: CODE_LOOK.inlineRadius * size,
				above: metrics.ascent * size + paddingY,
				below: metrics.descent * size + paddingY,
			},
			padding: CODE_LOOK.inlinePadding.x * size,
		};
	}
	const metrics = metricsOf("sans");
	return {
		backdrop: {
			color: HIGHLIGHT.color,
			opacity: HIGHLIGHT.opacity,
			radius: HIGHLIGHT.radius,
			above: metrics.ascent * base.size,
			below: metrics.descent * base.size,
		},
		padding: HIGHLIGHT.paddingX,
	};
}

/** Text of `base` with `marks`, as the app's styles draw each. */
function runOf(
	text: string,
	base: Type,
	marks: readonly Mark[],
	backdrops: readonly Backdrop[],
): Run {
	const has = (name: string) => marks.some((mark) => mark.type.name === name);
	const script = has("superscript") ? "superscript" : has("subscript") ? "subscript" : undefined;
	const scriptSize = script ? base.size * SCRIPT.scale : base.size;
	const code = has("code");
	return {
		kind: "run",
		text: text.normalize("NFC"),
		type: {
			...base,
			face: {
				family: code ? "mono" : base.face.family,
				weight: has("bold") ? bolder(base.face.weight) : base.face.weight,
				italic: base.face.italic || has("italic"),
			},
			size: code ? scriptSize * CODE_LOOK.inlineScale : scriptSize,
		},
		raise:
			script === "superscript"
				? SCRIPT.superscriptRaise * scriptSize
				: script === "subscript"
					? -SCRIPT.subscriptDrop * scriptSize
					: 0,
		sized: !script,
		// A link that goes nowhere a file's link may is drawn as a link that goes nowhere, as in the app.
		underline: has("link") ? "link" : has("underline") ? "plain" : undefined,
		strike: has("strike"),
		link: linkInFile(marks.find((mark) => mark.type.name === "link")?.attrs.href),
		backdrops,
	};
}

/** A weight bolder than `weight`, as CSS's `bolder` makes one, which the app's bold is. */
const bolder = (weight: number) => (weight < 350 ? 400 : weight < 550 ? 700 : 900);

const COLLAPSIBLE_SPACE = /[ \t\n\r\f]/;

/** `inlines` with each stretch of white space one space, and none at the start or after a line break. */
function withWhiteSpaceCollapsed(inlines: readonly Inline[]): Inline[] {
	let afterSpace = true;
	return inlines.map((inline) => {
		if (inline.kind === "break") afterSpace = true;
		if (inline.kind !== "run") return inline;
		let text = "";
		for (const character of inline.text) {
			if (!COLLAPSIBLE_SPACE.test(character)) {
				text += character;
				afterSpace = false;
			} else if (!afterSpace) {
				text += " ";
				afterSpace = true;
			}
		}
		return { ...inline, text };
	});
}

/** A piece of a word: some of a run's text, or a box's padding. */
interface Bit {
	inline: Run | Padding;
	text: string;
	width: number;
}

/** What a line may break after: text up to a space, a zero-width space or a soft hyphen, with it. */
interface Word {
	bits: readonly Bit[];
	width: number;
	/** Its trailing space's width, which hangs at the end of a line. */
	trailing: number;
	/** The hyphen a soft hyphen it ends with shows at the end of a line that breaks there. */
	hyphen: Bit | undefined;
}

/** A line laid out: its bits, and how far it reaches above its baseline and below. */
interface Line {
	bits: readonly Bit[];
	width: number;
	above: number;
	below: number;
	/** The bits that end a word with a space, but for the last: where a justified line takes its room to spare. */
	gaps: ReadonlySet<number>;
}

/** How a textblock's lines are set: across how much, where each sits across it, and whether they are made as even as they can be. */
interface LineSetting {
	width: number;
	align: TextAlign;
	balanced: boolean;
}

/** The most lines a browser evens out. */
const MOST_BALANCED_LINES = 6;

/** Where a line may break, after the character: a space, a zero-width space and a soft hyphen. */
const BREAKS_AFTER = /(?<=[ \u200b\u00ad])/;

const SOFT_HYPHEN = "\u00ad";

/** What a soft hyphen shows at the end of a line that breaks there. */
const HYPHEN = "-";

/**
 * `inlines` in lines, each where its alignment sits it across the width: a
 * justified line that ends where the text wraps is stretched across it at
 * its spaces, and a line wider than the width starts at its left, as CSS sets
 * them.
 */
function laidLines(
	inlines: readonly Inline[],
	blockType: BlockType,
	measure: Measure,
	{ width, align, balanced }: LineSetting,
	room: number,
): Laid {
	// Each line is a line of its block's own type at least, so this many reach past the room.
	const strut = lineBoxOf([blockType.type], blockType.lineHeight);
	const mostLines = Math.max(1, Math.floor(room / (strut.above + strut.below)) + 1);
	const segments = segmentsOf(inlines).map((segment) => wordsOf(segment, measure));
	const fill = (across: number) => {
		const lines: { words: Word[]; broken: boolean }[] = [];
		for (const [index, words] of segments.entries()) {
			if (lines.length >= mostLines) break;
			const filled = filledLines(words, across, measure, mostLines - lines.length);
			// A break makes a line of its own, even an empty one, but not after the last.
			if (filled.length === 0 && index < segments.length - 1)
				lines.push({ words: [], broken: false });
			for (const [lineIndex, line] of filled.entries()) {
				lines.push({ words: line, broken: lineIndex < filled.length - 1 });
			}
		}
		return lines;
	};
	let lines = fill(width);
	const reachesPastRoom = lines.length >= mostLines;
	if (balanced && !reachesPastRoom && lines.length > 1 && lines.length <= MOST_BALANCED_LINES) {
		const count = lines.length;
		let low = 0;
		let high = width;
		for (let step = 0; step < 12; step++) {
			const middle = (low + high) / 2;
			if (fill(middle).length <= count) high = middle;
			else low = middle;
		}
		lines = fill(high);
	}
	if (lines.length === 0) return NOTHING;
	return stacked(
		lines.map(({ words, broken }) => {
			const line = lineOf(words, blockType, broken);
			const spare = Math.max(0, width - line.width);
			const indent = align === "center" ? spare / 2 : align === "right" ? spare : 0;
			const stretch =
				align === "justify" && broken && line.gaps.size > 0 ? spare / line.gaps.size : 0;
			return {
				height: line.above + line.below,
				width: align === "left" ? line.width : Math.max(width, line.width),
				baseline: line.above,
				draw: (pen, x, y) => drawLine(line, x + indent, y, pen, stretch),
			};
		}),
		0,
	);
}

/** `inlines` between their line breaks. */
function segmentsOf(inlines: readonly Inline[]): (Run | Padding)[][] {
	const segments: (Run | Padding)[][] = [[]];
	for (const inline of inlines) {
		if (inline.kind === "break") segments.push([]);
		else segments.at(-1)?.push(inline);
	}
	return segments;
}

function wordsOf(segment: readonly (Run | Padding)[], measure: Measure): Word[] {
	const words: Word[] = [];
	let bits: Bit[] = [];
	const end = (trailing: number, hyphen?: Bit) => {
		if (bits.length > 0) words.push({ bits, width: widthOfBits(bits), trailing, hyphen });
		bits = [];
	};
	for (const inline of segment) {
		if (inline.kind === "padding") {
			bits.push({ inline, text: "", width: inline.width });
			continue;
		}
		for (const chunk of inline.text.split(BREAKS_AFTER)) {
			if (chunk === "") continue;
			const width =
				chunk.length > LONGEST_WORD_MEASURED
					? Number.POSITIVE_INFINITY
					: measure.widthOf(inline.type, chunk);
			bits.push({ inline, text: chunk, width });
			if (chunk.endsWith(" ")) end(measure.widthOf(inline.type, " "));
			else if (chunk.endsWith(SOFT_HYPHEN)) {
				end(0, { inline, text: HYPHEN, width: measure.widthOf(inline.type, HYPHEN) });
			} else if (chunk.endsWith("\u200b")) end(0);
		}
	}
	end(0);
	return words;
}

/**
 * The most characters a word is measured whole with: more than a line holds
 * at the smallest size a slide sets text at. A longer word is taken to be
 * wider than its line, and so is broken into lines a character at a time,
 * only as many as there is room for, rather than measured whole.
 */
const LONGEST_WORD_MEASURED = 1000;

function widthOfBits(bits: readonly Bit[]): number {
	let width = 0;
	for (const bit of bits) width += bit.width;
	return width;
}

/** How much wider than its line a line may measure and still be taken to fit it, for rounding. */
const LINE_ALLOWANCE = 0.01;

/**
 * `words` in lines no wider than `width`, a word wider than that broken where
 * it must be, as many as `mostLines`. A line that breaks at a soft hyphen has
 * room for the hyphen it shows, or the word goes on to the next line whole.
 */
function filledLines(
	words: readonly Word[],
	width: number,
	measure: Measure,
	mostLines: number,
): Word[][] {
	const lines: Word[][] = [];
	let line: Word[] = [];
	let used = 0;
	const endLine = () => {
		const last = line.at(-1);
		if (last?.hyphen && line.length > 1 && used + last.hyphen.width > width + LINE_ALLOWANCE) {
			line.pop();
			lines.push(line);
			line = [last];
			used = last.width;
			return;
		}
		lines.push(line);
		line = [];
		used = 0;
	};
	for (const word of words) {
		if (lines.length >= mostLines) return lines;
		while (line.length > 0 && used + word.width - word.trailing > width + LINE_ALLOWANCE) {
			endLine();
		}
		if (line.length === 0 && word.width - word.trailing > width + LINE_ALLOWANCE) {
			const pieces = brokenWord(word, width, measure, mostLines - lines.length);
			const last = pieces.pop();
			for (const piece of pieces) lines.push([piece]);
			if (last) {
				line = [last];
				used = last.width;
			}
			continue;
		}
		line.push(word);
		used += word.width;
	}
	if (line.length > 0) lines.push(line);
	return lines;
}

/** `word` in pieces no wider than `width`, each of one character at least, as many as `mostPieces`. */
function brokenWord(word: Word, width: number, measure: Measure, mostPieces: number): Word[] {
	const pieces: Word[] = [];
	let bits: Bit[] = [];
	let used = 0;
	const end = () => {
		if (bits.length > 0) {
			pieces.push({ bits, width: widthOfBits(bits), trailing: 0, hyphen: undefined });
		}
		bits = [];
		used = 0;
	};
	for (const bit of word.bits) {
		if (pieces.length >= mostPieces) break;
		if (bit.inline.kind === "padding") {
			bits.push(bit);
			used += bit.width;
			continue;
		}
		const run = bit.inline;
		let text = "";
		for (const character of bit.text) {
			const characterWidth = measure.widthOf(run.type, character);
			if (used + characterWidth > width && (text !== "" || bits.length > 0) && character !== " ") {
				if (text !== "") bits.push({ inline: run, text, width: measure.widthOf(run.type, text) });
				end();
				text = "";
				if (pieces.length >= mostPieces) break;
			}
			text += character;
			used += characterWidth;
		}
		if (text !== "") bits.push({ inline: run, text, width: measure.widthOf(run.type, text) });
	}
	end();
	const last = pieces.at(-1);
	if (last) pieces[pieces.length - 1] = { ...last, trailing: word.trailing, hyphen: word.hyphen };
	return pieces;
}

/**
 * `words` as a line, its trailing space dropped, as tall as its tallest text
 * and its block's own line; with the hyphen of a soft hyphen it ends with,
 * when it is `broken` there.
 */
function lineOf(words: readonly Word[], { type, lineHeight }: BlockType, broken: boolean): Line {
	const bits = words.flatMap((word) => word.bits);
	const gaps = new Set<number>();
	let ends = -1;
	for (const word of words.slice(0, -1)) {
		ends += word.bits.length;
		if (word.trailing > 0) gaps.add(ends);
	}
	const last = bits.at(-1);
	const lastWord = words.at(-1);
	const trailing = lastWord?.trailing ?? 0;
	const trimmed =
		last?.inline.kind === "run" && last.text.endsWith(" ")
			? [
					...bits.slice(0, -1),
					{ ...last, text: last.text.slice(0, -1), width: last.width - trailing },
				]
			: bits;
	const shown = broken && lastWord?.hyphen ? [...trimmed, lastWord.hyphen] : trimmed;
	const sized = shown.flatMap((bit) =>
		bit.inline.kind === "run" && bit.inline.sized && bit.text !== "" ? [bit.inline.type] : [],
	);
	const box = lineBoxOf([type, ...sized], lineHeight);
	return { bits: shown, width: widthOfBits(shown), ...box, gaps };
}

/**
 * How far a line of `types` reaches above its baseline and below, as CSS sets
 * a line: each type's text with its share of the line height above and below.
 */
function lineBoxOf(types: readonly Type[], lineHeight: number): { above: number; below: number } {
	let above = 0;
	let below = 0;
	for (const { face, size } of types) {
		const metrics = metricsOf(face.family);
		const ascent = metrics.ascent * size;
		const descent = metrics.descent * size;
		const leading = (lineHeight * size - ascent - descent) / 2;
		above = Math.max(above, ascent + leading);
		below = Math.max(below, descent + leading);
	}
	return { above, below };
}

/**
 * A line, with its top at `top` and `stretch` more room at each of its gaps
 * (`Line.gaps`): the boxes behind its text, its text, its lines through and
 * under it, and its links.
 */
function drawLine(line: Line, x: number, top: number, pen: Pen, stretch: number) {
	const baseline = top + line.above;
	const placed: { bit: Bit; at: number }[] = [];
	let cursor = x;
	for (const [index, bit] of line.bits.entries()) {
		placed.push({ bit, at: cursor });
		cursor += bit.width + (line.gaps.has(index) ? stretch : 0);
	}
	const backdrops = new Map<Backdrop, { from: number; to: number }>();
	for (const { bit, at } of placed) {
		for (const backdrop of bit.inline.backdrops) {
			const extent = backdrops.get(backdrop);
			backdrops.set(backdrop, {
				from: Math.min(extent?.from ?? at, at),
				to: Math.max(extent?.to ?? at, at + bit.width),
			});
		}
	}
	for (const [backdrop, { from, to }] of backdrops) {
		pen.fill(
			{
				x: from,
				y: baseline - backdrop.above,
				width: to - from,
				height: backdrop.above + backdrop.below,
			},
			{ color: backdrop.color, opacity: backdrop.opacity, radius: backdrop.radius },
		);
	}
	for (const { bit, at } of placed) {
		if (bit.inline.kind !== "run" || bit.text === "") continue;
		const run = bit.inline;
		const runBaseline = baseline - run.raise;
		pen.text(run.type, bit.text, at, runBaseline);
		drawDecorations(run, { x: at, width: bit.width }, runBaseline, pen);
	}
	drawLinks(placed, { y: top, height: line.above + line.below }, pen);
}

function drawDecorations(
	run: Run,
	{ x, width }: { x: number; width: number },
	baseline: number,
	pen: Pen,
) {
	const metrics = metricsOf(run.type.face.family);
	const { size, color, opacity } = run.type;
	if (run.underline) {
		const offset = run.underline === "link" ? LINK_UNDERLINE_OFFSET : metrics.underlinePosition;
		pen.fill(
			{ x, y: baseline + offset * size, width, height: metrics.underlineThickness * size },
			{ color, opacity },
		);
	}
	if (run.strike) {
		const height = metrics.strikeoutThickness * size;
		pen.fill(
			{ x, y: baseline - metrics.strikeoutPosition * size, width, height },
			{ color, opacity },
		);
	}
}

/** A link over each stretch of a line that goes to one place. */
function drawLinks(
	placed: readonly { bit: Bit; at: number }[],
	{ y, height }: { y: number; height: number },
	pen: Pen,
) {
	let current: { url: string; from: number; to: number } | undefined;
	const end = () => {
		if (current)
			pen.link({ x: current.from, y, width: current.to - current.from, height }, current.url);
		current = undefined;
	};
	for (const { bit, at } of placed) {
		const url = bit.inline.kind === "run" ? bit.inline.link : current?.url;
		if (url !== current?.url) end();
		if (!url) continue;
		current = current ? { ...current, to: at + bit.width } : { url, from: at, to: at + bit.width };
	}
	end();
}
