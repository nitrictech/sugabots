import { placementOf, SLIDE_TEXT_STEPS } from "@sugabots/contracts/live-slides";
import {
	type BoxRole,
	type Frame,
	type Placement,
	roomBottom,
	SLIDE_BOX_ROLES,
	SLIDE_END_MARGIN,
	SLIDE_HEIGHT,
	SLIDE_SIDE_MARGINS,
	SLIDE_UNIT,
	SLIDE_WIDTH,
	type SlideLayout,
} from "@sugabots/contracts/slides-markdown";
import type { Mark, Node } from "@tiptap/pm/model";
import { metricsOf, type TextType } from "./pdf-fonts.ts";
import {
	ACCENT,
	accentBarOver,
	BLOCK_QUOTE_LOOK,
	type BlocksOfLayout,
	BOX_PARTS,
	CODE_LOOK,
	COLUMN_GAP_UNITS,
	COLUMN_LOOK,
	CONTENT_BOTTOM,
	CONTENT_HEIGHT,
	contentWidthOf,
	HIGHLIGHT,
	IMAGE_LAYOUT,
	IMAGE_RADIUS,
	IMAGE_WORDS_LOOK,
	LAYOUT_LOOKS,
	type LayoutLook,
	LINK_UNDERLINE_OFFSET,
	LIST_LOOK,
	linkInFile,
	partLook,
	QUOTE_LOOK,
	RULE,
	RULE_THICKNESS,
	SCRIPT,
	SECTION_BAR,
	type SlideBlocks,
	type SlidePart,
	slideBlocksOf,
	TABLE_LOOK,
	TEXT,
	type TextLook,
	TINT,
} from "./slide-design.ts";

/*
 * A deck's slides laid out as the app's slide styles lay them out
 * (`slide-design.ts`), measured in its fonts, each at the largest of
 * `SLIDE_TEXT_STEPS` at which it fits, as in the app. A slide whose boxes
 * somebody placed by hand has each box at its frame, as the app draws a
 * placed slide (`placedBoxes`). The PDF draws a slide where it is laid out
 * (`pdf.ts`), and the PowerPoint file sets a slide's text at the step it is
 * laid out at, in boxes as tall as it is laid out (`powerpoint.ts`).
 *
 * Everything is laid out first, measured, and drawn after with a pen where it
 * was laid out, so a slide's text can be laid out again at a smaller step
 * before anything is drawn, and measured without being drawn at all.
 *
 * A slide is cut off at the margin at its foot, or, once its boxes are
 * placed by hand, at its edges, as the app cuts each off; the pen cuts off
 * what is drawn past that (`Pen.clipped`). What is stacked one thing under
 * another leaves out what starts where it is cut off (`stacked`), numbers,
 * rules and links with it, and is laid out only as far as it takes to know
 * the slide can't fit, or as far as the slide shows, so a slide that runs
 * over by any amount costs no more than one that runs over a little.
 */

/** How a stretch of text is set, and its colour. */
export interface Type extends TextType {
	color: string;
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
	/** The image the deck keeps at `address`, one `Measure.imageSizeAt` gives a size for. */
	image(address: string, box: Box, radius: number): void;
	/** Draws what `draw` draws, cut off at the edges of `box`. */
	clipped(box: Box, draw: () => void): void;
	/** Whether what is drawn from `y` down is cut off whole: `y` is at or past the foot of a box drawing is cut off at (`clipped`). */
	cutsOffFrom(y: number): boolean;
	/** A link over `box`, as far as what it is drawn within shows. */
	link(box: Box, url: string): void;
}

/** What is inherited down a slide's blocks, as CSS inherits it. */
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
	/** The most an image may be tall, in points: unbounded but for the image layout's image. */
	imageMaxHeight: number;
	/** An image's corners, in ems of its text. */
	imageRadius: number;
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
 * its top it may reach and the slide still fit. Past that, nothing more of it
 * is laid out, and it is taken to reach past the room.
 */
type LayOut = (room: number) => Laid;

const NOTHING: Laid = { height: 0, width: 0, baseline: undefined, draw: () => {} };

/** A slide laid out: the step its text is drawn at, whether it fits at it, and drawing it. */
export interface ArrangedSlide {
	/** One of `SLIDE_TEXT_STEPS`. */
	step: number;
	fits: boolean;
	/** Draws the slide, cut off where the app cuts it off. */
	draw: (pen: Pen) => void;
}

/** How far past the room it has a slide's content may reach and still fit, as the app allows a pixel for rounding. */
const FIT_ALLOWANCE = 1;

/** The room a slide's content has, from the margin at its top. */
const SLIDE_ROOM = CONTENT_HEIGHT + FIT_ALLOWANCE;

/** Where a slide its layout places is cut off: at the margin at its foot. */
const WITHIN_MARGINS: Box = { x: 0, y: 0, width: SLIDE_WIDTH, height: CONTENT_BOTTOM };

/** Where a slide whose boxes were placed by hand is cut off: at its edges. */
const WHOLE_SLIDE: Box = { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT };

/**
 * `slide` laid out at the largest step at which it fits, or the smallest: by
 * its layout, or, where somebody placed its boxes by hand, each box at its
 * frame (`placedBoxes`).
 */
export function arrangedSlide(slide: Node, measure: Measure): ArrangedSlide {
	const blocks = slideBlocksOf(slide);
	const placement = placementOf(slide);
	const cutOffAt = placement ? WHOLE_SLIDE : WITHIN_MARGINS;
	const atStep = (step: number): ArrangedSlide => {
		const { fits, draw } = placement
			? placedBoxes(blocks, placement, measure, step)
			: arranged(blocks, measure, step * SLIDE_UNIT);
		return { step, fits, draw: (pen) => pen.clipped(cutOffAt, () => draw(pen)) };
	};
	const [largest, ...smaller] = SLIDE_TEXT_STEPS;
	let arrangement = atStep(largest);
	for (const step of smaller) {
		if (arrangement.fits) break;
		arrangement = atStep(step);
	}
	return arrangement;
}

/** Where on a slide blocks are set: in which part of a slide of which layout, at which step, and across how much. */
export interface Placing {
	layout: SlideLayout;
	part: SlidePart;
	/** One of `SLIDE_TEXT_STEPS`. */
	step: number;
	/** In points. */
	width: number;
	/**
	 * How tall the box the blocks are in is, in points, on a slide whose boxes
	 * somebody placed by hand, where no image in a box is taller than the box:
	 * `undefined` on a slide its layout places.
	 */
	boxHeight: number | undefined;
}

/**
 * How tall `blocks` are, one under another, set as `placing` says, in points;
 * as tall as a slide's content may be and more, when they are taller.
 */
export function heightOfBlocks(
	blocks: readonly Node[],
	placing: Placing,
	measure: Measure,
): number {
	const setting = settingOf(placing, measure);
	return stackedWithin(
		blocks.map((block) => (room) => laidBlock(block, setting, placing.width, room)),
		partLook(placing.layout, placing.part).gap * setting.unit,
		SLIDE_ROOM,
	).height;
}

/**
 * How tall each of `table`'s rows is, set as `placing` says, in points: its
 * cells' padding and text, and the rule under it. Rows past as much as a
 * slide's content may be aren't measured.
 */
export function rowHeightsOf(table: Node, placing: Placing, measure: Measure): number[] {
	const setting = settingOf(placing, measure);
	return tableRows(table, setting, placing.width, SLIDE_ROOM).map((row) => row.height);
}

/** What blocks set as `placing` says inherit. */
function settingOf(placing: Placing, measure: Measure): Setting {
	const setting = settingIn(placing.layout, placing.part, measure, placing.step * SLIDE_UNIT);
	if (placing.boxHeight === undefined) return setting;
	return { ...setting, imageMaxHeight: Math.min(setting.imageMaxHeight, placing.boxHeight) };
}

/** What the blocks in `part` of a slide of `layout` inherit, at `unit`. */
function settingIn(layout: SlideLayout, part: SlidePart, measure: Measure, unit: number): Setting {
	const look = partLook(layout, part);
	const imageColumn = part === "imageColumn";
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
		imageMaxHeight: imageColumn
			? IMAGE_LAYOUT.imageMaxHeight * SLIDE_UNIT
			: Number.POSITIVE_INFINITY,
		imageRadius: imageColumn ? IMAGE_LAYOUT.imageRadius : IMAGE_RADIUS,
	};
}

const REGULAR = 400;

/** A slide laid out: whether it fits within its margins, and drawing it. */
interface Arrangement {
	fits: boolean;
	draw: (pen: Pen) => void;
}

/** `blocks`, a slide's, laid out by the slide's layout, the slide's unit at its text's step being `unit`. */
function arranged(blocks: SlideBlocks, measure: Measure, unit: number): Arrangement {
	const { layout } = blocks;
	const look = LAYOUT_LOOKS[layout];
	const setting = settingIn(layout, "flow", measure, unit);
	switch (blocks.layout) {
		case "columns":
			return inColumns(blocks, setting, settingIn(layout, "column", measure, unit));
		case "image":
			return besideImage(
				blocks,
				setting,
				settingIn(layout, "imageText", measure, unit),
				settingIn(layout, "imageColumn", measure, unit),
			);
		case "section":
			return inFlow(
				blocks.all,
				setting,
				look,
				SLIDE_SIDE_MARGINS[layout],
				blocks.shows("label") ? sectionBar(setting) : undefined,
			);
		default:
			return inFlow(blocks.all, setting, look, SLIDE_SIDE_MARGINS[layout]);
	}
}

const fitsSlide = (height: number) => height <= SLIDE_ROOM;

/**
 * Blocks one under another within `sideMargin` at either side, as far apart
 * as `look` sets them, where it sets them, after `first`.
 */
function inFlow(
	blocks: readonly Node[],
	setting: Setting,
	look: LayoutLook,
	sideMargin: number,
	first?: Laid,
): Arrangement {
	const width = SLIDE_WIDTH - 2 * sideMargin;
	const laid = stackedWithin(
		[
			...(first ? [() => first] : []),
			...blocks.map(
				(block): LayOut =>
					(room) =>
						laidBlock(block, setting, width, room),
			),
		],
		look.gap * setting.unit,
		SLIDE_ROOM,
	);
	const fits = fitsSlide(laid.height);
	const room = CONTENT_HEIGHT - laid.height;
	const offset = !fits ? 0 : look.align === "center" ? room / 2 : look.align === "end" ? room : 0;
	return { fits, draw: (pen) => laid.draw(pen, sideMargin, SLIDE_END_MARGIN + offset) };
}

/** The title across the top, and the two columns side by side under it. */
function inColumns(
	blocks: BlocksOfLayout<"columns">,
	setting: Setting,
	columnSetting: Setting,
): Arrangement {
	const gap = COLUMN_GAP_UNITS * setting.unit;
	const width = contentWidthOf("columns");
	const columnWidth = (width - gap) / 2;
	const across = blocks.inBox("title").map(
		(block): LayOut =>
			(room) =>
				laidBlock(block, setting, width, room),
	);
	const columns: LayOut = (room) => {
		const left = laidColumn(blocks.inBox("leftColumn"), columnSetting, columnWidth, room);
		const right = laidColumn(blocks.inBox("rightColumn"), columnSetting, columnWidth, room);
		return {
			height: Math.max(left.height, right.height),
			width,
			baseline: undefined,
			draw: (pen, x, y) => {
				left.draw(pen, x, y);
				right.draw(pen, x + columnWidth + gap, y);
			},
		};
	};
	const laid = stackedWithin(
		[...across, columns],
		LAYOUT_LOOKS.columns.gap * setting.unit,
		SLIDE_ROOM,
	);
	return {
		fits: fitsSlide(laid.height),
		draw: (pen) => laid.draw(pen, SLIDE_SIDE_MARGINS.columns, SLIDE_END_MARGIN),
	};
}

/**
 * The title, and the text box under it, together in the middle of the left,
 * and the image box in the middle of the right.
 */
function besideImage(
	blocks: BlocksOfLayout<"image">,
	setting: Setting,
	textSetting: Setting,
	imageSetting: Setting,
): Arrangement {
	const gap = COLUMN_GAP_UNITS * setting.unit;
	const sideMargin = SLIDE_SIDE_MARGINS.image;
	const columnWidth = (contentWidthOf("image") - gap) / 2;
	const heads = blocks.inBox("title");
	const head = stackedWithin(
		heads.map(
			(block): LayOut =>
				(room) =>
					laidBlock(block, setting, columnWidth, room),
		),
		IMAGE_LAYOUT.titleBlockGap * setting.unit,
		SLIDE_ROOM,
	);
	const titleGap = heads.length > 0 ? IMAGE_LAYOUT.titleGap * setting.unit : 0;
	const text = laidColumn(
		blocks.inBox("text"),
		textSetting,
		columnWidth,
		SLIDE_ROOM - head.height - titleGap,
	);
	const image = laidColumn(blocks.inBox("image"), imageSetting, columnWidth, SLIDE_ROOM, "center");
	const leftHeight = head.height + titleGap + text.height;
	const height = Math.max(CONTENT_HEIGHT, leftHeight, image.height);
	return {
		fits: fitsSlide(Math.max(leftHeight, image.height)),
		draw: (pen) => {
			const leftTop = SLIDE_END_MARGIN + (height - leftHeight) / 2;
			head.draw(pen, sideMargin, leftTop);
			text.draw(pen, sideMargin, leftTop + head.height + titleGap);
			image.draw(
				pen,
				sideMargin + columnWidth + gap,
				SLIDE_END_MARGIN + (height - image.height) / 2,
			);
		},
	};
}

function laidColumn(
	blocks: readonly Node[],
	setting: Setting,
	width: number,
	room: number,
	align: "start" | "center" = "start",
): Laid {
	return stackedWithin(
		blocks.map(
			(block): LayOut =>
				(blockRoom) =>
					laidBlock(block, setting, width, blockRoom),
		),
		COLUMN_LOOK.gap * setting.unit,
		room,
		align === "center" ? width : undefined,
	);
}

/**
 * A slide whose boxes somebody placed by hand, its text at `step`: each box
 * it shows at its frame (`placedBox`), and nothing else, whatever its
 * layout's margins, as the app draws a placed slide. It fits when what each
 * box holds ends no lower than the room the box has on the slide
 * (`roomBottom`), give or take the pixel the app allows, as the app fits it.
 */
function placedBoxes(
	blocks: SlideBlocks,
	placement: Placement,
	measure: Measure,
	step: number,
): Arrangement {
	const roles: readonly BoxRole[] = SLIDE_BOX_ROLES[blocks.layout];
	const shown = roles.map((_, index) => blocks.boxes[index] !== undefined);
	const boxes = roles.flatMap((role, index) => {
		const frame = placement[index];
		const held = blocks.boxes[index];
		if (!frame || !held) return [];
		const box = placedBox(blocks.layout, role, held, frame, measure, step);
		return [{ ...box, fits: box.bottom <= roomBottom(placement, shown, index) + FIT_ALLOWANCE }];
	});
	return {
		fits: boxes.every((box) => box.fits),
		draw: (pen) => {
			for (const box of boxes) box.draw(pen);
		},
	};
}

/**
 * What a box of `role` placed at `frame` holds, laid out as the app's styles
 * for a placed slide set it: across the frame, as far apart as the box's
 * role sets its blocks, from the frame's top, but in the middle of the frame
 * both ways in the image layout's image box; no image in it taller than the
 * frame; and over a section break's label, the accent bar. It is laid out as
 * far down as the slide shows, and `bottom` is how far down the slide what it
 * holds reaches.
 */
function placedBox(
	layout: SlideLayout,
	role: BoxRole,
	blocks: readonly Node[],
	frame: Frame,
	measure: Measure,
	step: number,
): { bottom: number; draw: (pen: Pen) => void } {
	const setting = settingOf(
		{ layout, part: BOX_PARTS[role], step, width: frame.width, boxHeight: frame.height },
		measure,
	);
	const centred = role === "image";
	const shownBelowTop = SLIDE_HEIGHT - frame.y;
	const laid = stackedWithin(
		blocks.map(
			(block): LayOut =>
				(room) =>
					laidBlock(block, setting, frame.width, room),
		),
		boxGap(layout, role) * setting.unit,
		// Centred, what is taller than the frame reaches below it by half as much as it is taller.
		centred ? 2 * shownBelowTop - frame.height : shownBelowTop,
		centred ? frame.width : undefined,
	);
	const top = centred ? frame.y + (frame.height - laid.height) / 2 : frame.y;
	const bar = role === "label" ? sectionBar(setting) : undefined;
	return {
		bottom: top + laid.height,
		draw: (pen) => {
			if (bar) {
				const over = accentBarOver(frame, setting.unit);
				bar.draw(pen, over.x, over.y);
			}
			laid.draw(pen, frame.x, top);
		},
	};
}

/**
 * The space between the blocks a box of `role` holds, in units of the step,
 * as the app's styles set it: its part's, but in the image layout's title,
 * whose layout sets none between its rows, none.
 */
const boxGap = (layout: SlideLayout, role: BoxRole) =>
	layout === "image" && role === "title"
		? IMAGE_LAYOUT.titleBlockGap
		: partLook(layout, BOX_PARTS[role]).gap;

/** The section break's accent bar, over its label and title, which goes with its label when that is removed. */
function sectionBar({ unit }: Setting): Laid {
	const width = SECTION_BAR.width * unit;
	const height = SECTION_BAR.height * unit;
	return {
		height,
		width,
		baseline: undefined,
		draw: (pen, x, y) =>
			pen.fill({ x, y, width, height }, { color: ACCENT, radius: SECTION_BAR.radius * unit }),
	};
}

/**
 * `items` one under another, `gap` apart, each at the left, or each in the
 * middle of `centredIn` when given. Drawn, those that start where the pen
 * cuts off what it draws (`Pen.cutsOffFrom`) are left out.
 */
function stacked(items: readonly Laid[], gap: number, centredIn?: number): Laid {
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
		width: centredIn ?? widest,
		baseline:
			first?.baseline === undefined ? undefined : (tops[firstWithLines] ?? 0) + first.baseline,
		draw: (pen, x, y) => {
			for (const [index, item] of items.entries()) {
				const top = y + (tops[index] ?? 0);
				if (pen.cutsOffFrom(top)) return;
				const indent = centredIn === undefined ? 0 : (centredIn - item.width) / 2;
				item.draw(pen, x + indent, top);
			}
		},
	};
}

/**
 * What `layOuts` lay out, one under another, `gap` apart, as `stacked` stacks
 * them, as far as `room` reaches: one that would start past it isn't laid
 * out, and the stack is taken to reach to where it would have started.
 */
function stackedWithin(
	layOuts: readonly LayOut[],
	gap: number,
	room: number,
	centredIn?: number,
): Laid {
	const items: Laid[] = [];
	let height = 0;
	for (const layOut of layOuts) {
		const top = items.length === 0 ? 0 : height + gap;
		if (top > room) return { ...stacked(items, gap, centredIn), height: top };
		const item = layOut(room - top);
		items.push(item);
		height = top + item.height;
	}
	return stacked(items, gap, centredIn);
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
				: stackedWithin(
						block.children.map(
							(child): LayOut =>
								(childRoom) =>
									laidBlock(child, setting, width, childRoom),
						),
						0,
						room,
					);
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

/** Headings up to the third take the layout's heading look; those below are the size and weight of what is around them. */
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
	const size = look.size * setting.unit;
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
 * A paragraph or heading: its lines, and each image in it on its own, as the
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
	const parts: LayOut[] = [];
	let words: Node[] = [];
	const endWords = () => {
		if (words.length > 0) {
			const inlines = inlinesOf(words, blockType.type);
			parts.push((partRoom) =>
				laidLines(inlines, blockType, setting.measure, width, balanced, partRoom),
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
		parts.push(() => laidImage(child, blockType, setting, width));
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
	const scale = Math.min(1, width / natural.width, setting.imageMaxHeight / natural.height);
	const box = { width: natural.width * scale, height: natural.height * scale };
	const link = linkInFile(image.attrs.link);
	return {
		...box,
		baseline: undefined,
		draw: (pen, x, y) => {
			pen.image(address, { x, y, ...box }, setting.imageRadius * around.type.size);
			if (link) pen.link({ x, y, ...box }, link);
		},
	};
}

/** An image's words, in a dashed box across the width, as the app draws an image without its picture as a block. */
function laidImageWords(words: string, around: BlockType, measure: Measure, width: number): Laid {
	const { padding, radius, color, border } = IMAGE_WORDS_LOOK;
	const inset = { x: padding.x + 1, y: padding.y + 1 };
	const type: BlockType = { ...around, type: { ...around.type, color } };
	const lines = laidLines(
		withWhiteSpaceCollapsed([runOf(words, type.type, [], [])]),
		type,
		measure,
		Math.max(0, width - 2 * inset.x),
		false,
		SLIDE_ROOM,
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
	const childrenOf = (inner: Setting, innerWidth: number) =>
		quote.children.map(
			(child): LayOut =>
				(childRoom) =>
					laidBlock(child, inner, innerWidth, childRoom),
		);
	if (setting.quoteLayout) {
		const quoteSetting: Setting = {
			...setting,
			text: QUOTE_LOOK,
			weight: QUOTE_LOOK.weight,
			tracking: QUOTE_LOOK.tracking * QUOTE_LOOK.size * setting.unit,
			balancedText: true,
		};
		return stackedWithin(childrenOf(quoteSetting, width), 0, room);
	}
	const rule = BLOCK_QUOTE_LOOK.rule * setting.fontSize;
	const indent = rule + BLOCK_QUOTE_LOOK.padding * setting.fontSize;
	const inner: Setting = { ...setting, text: { ...setting.text, color: BLOCK_QUOTE_LOOK.color } };
	const content = stackedWithin(childrenOf(inner, width - indent), 0, room);
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
			const padding = header ? TABLE_LOOK.headerPadding : TABLE_LOOK.cellPadding;
			const inset = { x: padding.x * fontSize, y: padding.y * fontSize };
			const span = Number(cell.attrs.colspan) || 1;
			const cellWidth = span * columnWidth;
			const content = stackedWithin(
				cell.children.map(
					(child): LayOut =>
						(childRoom) =>
							laidBlock(child, cellSetting, cellWidth - 2 * inset.x, childRoom),
				),
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
 * A textblock's inline nodes as runs of `base` with their marks: each box
 * behind a stretch of them padded at its ends, and each stretch of white
 * space one space, none at a line's start.
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
			const backdrop = BACKDROP_MARKS.has(mark.type.name) ? backdropOf(mark, base) : undefined;
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
			inlines.push(runOf(line, base, node.marks, backdrops()));
		}
	}
	closeTo(0);
	return withWhiteSpaceCollapsed(inlines);
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
}

/** The most lines a browser evens out. */
const MOST_BALANCED_LINES = 6;

/** Where a line may break, after the character: a space, a zero-width space and a soft hyphen. */
const BREAKS_AFTER = /(?<=[ \u200b\u00ad])/;

const SOFT_HYPHEN = "\u00ad";

/** What a soft hyphen shows at the end of a line that breaks there. */
const HYPHEN = "-";

function laidLines(
	inlines: readonly Inline[],
	blockType: BlockType,
	measure: Measure,
	width: number,
	balanced: boolean,
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
			return {
				height: line.above + line.below,
				width: line.width,
				baseline: line.above,
				draw: (pen, x, y) => drawLine(line, x, y, pen),
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
	return { bits: shown, width: widthOfBits(shown), ...box };
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

/** A line, with its top at `top`: the boxes behind its text, its text, its lines through and under it, and its links. */
function drawLine(line: Line, x: number, top: number, pen: Pen) {
	const baseline = top + line.above;
	const placed: { bit: Bit; at: number }[] = [];
	let cursor = x;
	for (const bit of line.bits) {
		placed.push({ bit, at: cursor });
		cursor += bit.width;
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
	const { size, color } = run.type;
	if (run.underline) {
		const offset = run.underline === "link" ? LINK_UNDERLINE_OFFSET : metrics.underlinePosition;
		pen.fill(
			{ x, y: baseline + offset * size, width, height: metrics.underlineThickness * size },
			{ color },
		);
	}
	if (run.strike) {
		const height = metrics.strikeoutThickness * size;
		pen.fill({ x, y: baseline - metrics.strikeoutPosition * size, width, height }, { color });
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
