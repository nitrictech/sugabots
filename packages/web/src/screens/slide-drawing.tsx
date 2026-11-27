import type { CssColor } from "@sugabots/contracts/css-values";
import { backgroundOf, bodyOf, layoutOf, SLIDE_TEXT_STEPS } from "@sugabots/contracts/live-slides";
import {
	type Frame,
	SLIDE_END_MARGIN,
	SLIDE_HEIGHT,
	SLIDE_WIDTH,
} from "@sugabots/contracts/slide-geometry";
import type { DOMSerializer, Node } from "@tiptap/pm/model";
import { cn } from "cn";
import { type CSSProperties, memo, useLayoutEffect, useRef } from "react";
import { boxesOf } from "@/lib/deck.ts";
import { drawnTextSizeOf, SIZED_BY_THEIR_TEXT, sizeOfText } from "@/lib/slide-text.ts";

/*
 * A deck's slide drawn read only, as the stage draws it while it is edited:
 * in the strip of slides, in present mode and wherever a deck is only read.
 * A slide is laid out in its own pixels, 960 across, and drawn scaled as one
 * piece to the width it is given (see the slide styles in `app.css`), so one
 * drawing serves at any size.
 */

/** The style property, on an element holding a slide, that sets the size its role-sized text is drawn at. */
const TEXT_STEP_PROPERTY = "--slide-fit";

/**
 * The style property, on an element holding a slide or on the slide itself,
 * that says the colour its body is painted, when the slide has one of its
 * own (`backgroundOf`). The slide's own element holds its notes too, so on
 * the stage its colour is painted on its body alone.
 */
export const SLIDE_PAINT_PROPERTY = "--slide-paint";

/**
 * The attribute, on the element holding a slide's body, that says which of
 * the theme's colour schemes the colours the body doesn't state are taken
 * from, its text's, its lists' markers' and its tables' rules among them,
 * for a slide of a colour of its own (`slidePaintOf`).
 */
export const SLIDE_SCHEME_ATTRIBUTE = "data-slide-scheme";

/** One of the theme's colour schemes: dark colours on light, or light on dark. */
export type ColorScheme = "light" | "dark";

/** How a slide of a colour of its own is painted: that colour, and the colour scheme to draw on it, if one is known. */
export interface SlidePaint {
	color: CssColor;
	scheme: ColorScheme | undefined;
}

/**
 * How `slide` is painted when it has a colour of its own (`backgroundOf`):
 * that colour, and the light scheme on a light colour or the dark one on a
 * dark colour, whatever the app's theme, so what it says in no colour of its
 * own reads on it. The stage and every drawing of a slide paint it so.
 */
export function slidePaintOf(slide: Node): SlidePaint | undefined {
	const color = backgroundOf(slide);
	return color ? { color, scheme: schemeFor(color) } : undefined;
}

/**
 * The luminance of a colour on which the theme's dark text and its light
 * text are about as easy to read: on a lighter colour the dark text is
 * easier, and on a darker one the light text.
 */
const EVEN_CONTRAST_LUMINANCE = 0.17;

/**
 * Which colour scheme reads better on `color`: `undefined` for a colour the
 * browser can't tell the shade of here, or one mostly see-through, on which
 * the theme's own scheme is read.
 */
function schemeFor(color: CssColor): ColorScheme | undefined {
	if (schemes.has(color)) return schemes.get(color);
	const channels = channelsOf(color);
	const scheme =
		channels && channels.alpha >= 0.5
			? luminanceOf(channels) > EVEN_CONTRAST_LUMINANCE
				? "light"
				: "dark"
			: undefined;
	schemes.set(color, scheme);
	return scheme;
}

const schemes = new Map<CssColor, ColorScheme | undefined>();

/** A colour's red, green and blue, each from 0 to 255, and how opaque it is, from 0 to 1. */
interface Channels {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}

const HEX_DIGITS = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The channels of `color`: read from a hex colour, as a file's colours are
 * written, and from any other by painting it, `undefined` where nothing can
 * paint here.
 */
function channelsOf(color: CssColor): Channels | undefined {
	const [, digits] = HEX_DIGITS.exec(color) ?? [];
	if (digits) {
		const long = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
		const [red = 0, green = 0, blue = 0, alpha = 255] = (long.match(/../g) ?? []).map((pair) =>
			Number.parseInt(pair, 16),
		);
		return { red, green, blue, alpha: alpha / 255 };
	}
	return paintedChannelsOf(color);
}

let painter: CanvasRenderingContext2D | null | undefined;

/** The channels of `color` painted on a pixel of a canvas of its own, as the browser paints it. */
function paintedChannelsOf(color: CssColor): Channels | undefined {
	painter ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (!painter) return undefined;
	painter.clearRect(0, 0, 1, 1);
	painter.fillStyle = color;
	painter.fillRect(0, 0, 1, 1);
	const [red = 0, green = 0, blue = 0, alpha = 0] = painter.getImageData(0, 0, 1, 1).data;
	return { red, green, blue, alpha: alpha / 255 };
}

/** How light `channels` are to the eye, from 0 for black to 1 for white, as contrast is reckoned. */
function luminanceOf({ red, green, blue }: Channels): number {
	const linear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** Finds a slide's drawn boxes, as the schema draws each (see `SlideBox` in `live-slides.ts`). */
export const DRAWN_BOX = "[data-slide-box]";

/** Finds what a drawn box holds, in an element of its own (see `SlideBox` in `live-slides.ts`). */
const DRAWN_BOX_CONTENT = ":scope > [data-box-content]";

/** Whether `box` holds text the slide styles size, which steps down to fit (see `ownTextSizeOf`). */
function holdsTextSizedByStyles(box: Node): boolean {
	let sized = false;
	box.descendants((node) => {
		sized ||= node.isText && sizeOfText(node) === undefined;
		return !sized;
	});
	return sized;
}

/**
 * Draws the text of the slide `slide`, whose body is drawn as `body`, inside
 * `holder`, at the largest step at which it fits. Answers whether it runs
 * over even at the smallest. Only the boxes holding text the slide styles
 * size are measured, as text of a size of its own is drawn at it wherever it
 * reaches. Nothing about it is stored: each drawing works it out.
 */
export function fitSlideText(holder: HTMLElement, body: HTMLElement, slide: Node): boolean {
	const boxes = boxesOf(slide);
	const stepping = boxes.map(({ node }) => holdsTextSizedByStyles(node));
	const worded = boxes.map(({ node }) => node.textContent.trim() !== "");
	for (const step of SLIDE_TEXT_STEPS) {
		holder.style.setProperty(TEXT_STEP_PROPERTY, String(step));
		if (everyBoxFits(body, stepping, worded)) return false;
	}
	return true;
}

/**
 * Whether what each box of `body` that `stepping` says steps holds stays
 * within the room the box has on the slide (`roomOf`), above it as well as
 * below, as what a box sets at its foot or in its middle grows upward too.
 * What runs past the edges of its box is drawn there, and only what runs
 * past its room is more than fits. `worded` says which boxes hold words,
 * which what another box holds may not run into. The boxes are measured
 * where they are drawn, in the slide's own pixels.
 */
function everyBoxFits(
	body: HTMLElement,
	stepping: readonly boolean[],
	worded: readonly boolean[],
): boolean {
	// A slide not drawn, as one hidden, has nothing to measure.
	const area = body.getBoundingClientRect();
	if (body.offsetWidth === 0 || area.width === 0) return true;
	const slidePxPerWindowPx = SLIDE_WIDTH / area.width;
	const boxes = [...body.querySelectorAll<HTMLElement>(DRAWN_BOX)];
	const frames = boxes.map(
		(box): Frame => ({
			x: box.offsetLeft,
			y: box.offsetTop,
			width: box.offsetWidth,
			height: box.offsetHeight,
		}),
	);
	return boxes.every((box, index) => {
		if (!stepping[index]) return true;
		const reach = reachOf(box, area, slidePxPerWindowPx);
		if (!reach) return true;
		const room = roomOf(frames, worded, index);
		return reach.top >= room.top - 1 && reach.bottom <= room.bottom + 1;
	});
}

/**
 * How far up and down the slide what `box` holds reaches, in the slide's
 * pixels from its top, measured from the slide's body drawn at `area`:
 * `undefined` for a box holding nothing drawn.
 */
function reachOf(
	box: HTMLElement,
	area: DOMRect,
	slidePxPerWindowPx: number,
): { top: number; bottom: number } | undefined {
	const content = box.querySelector(DRAWN_BOX_CONTENT);
	const blocks = content ? [...content.children] : [];
	const rects = blocks
		.map((block) => block.getBoundingClientRect())
		.filter((rect) => rect.height > 0);
	if (rects.length === 0) return undefined;
	return {
		top: (Math.min(...rects.map(({ top }) => top)) - area.top) * slidePxPerWindowPx,
		bottom: (Math.max(...rects.map(({ bottom }) => bottom)) - area.top) * slidePxPerWindowPx,
	};
}

/**
 * How far up and down a slide, in its pixels from its top, what the box
 * framed at `frames[index]` holds may reach before it is more than fits, on
 * a slide whose boxes are at `frames`, those `worded` says hold words.
 *
 * What a box holds may run past the edges of its frame, and is drawn there,
 * as far as the nearest box of words above or below it that it would run
 * into: one wholly above or below it that shares some of its width. A box it
 * already overlaps, as a caption over a picture, is no limit: the overlap is
 * the slide's design. With no such box, it may run as far as the margin the
 * layouts keep at the slide's top and foot (`SLIDE_END_MARGIN`). Its own
 * frame is always its to fill, though, so a frame set tall, or near an edge,
 * is usable in full.
 */
function roomOf(
	frames: readonly Frame[],
	worded: readonly boolean[],
	index: number,
): { top: number; bottom: number } {
	const frame = frames[index];
	if (!frame) return { top: 0, bottom: SLIDE_HEIGHT };
	const bottom = frame.y + frame.height;
	const limits = frames.filter(
		(other, at) => at !== index && worded[at] && shareWidth(other, frame) && !overlap(other, frame),
	);
	const below = limits.filter((other) => other.y >= bottom).map(({ y }) => y);
	const above = limits
		.filter((other) => other.y + other.height <= frame.y)
		.map((other) => other.y + other.height);
	return {
		top: Math.min(frame.y, above.length > 0 ? Math.max(...above) : SLIDE_END_MARGIN),
		bottom: Math.max(
			bottom,
			below.length > 0 ? Math.min(...below) : SLIDE_HEIGHT - SLIDE_END_MARGIN,
		),
	};
}

/** Whether `one` and `other` share some of a slide's width, so a line down the slide would cross both. */
const shareWidth = (one: Frame, other: Frame) =>
	one.x < other.x + other.width && other.x < one.x + one.width;

/** Whether `one` and `other` cover some of the same part of a slide. */
const overlap = (one: Frame, other: Frame) =>
	shareWidth(one, other) && one.y < other.y + other.height && other.y < one.y + one.height;

/**
 * Draws each line, list and list's item of `body`, the drawn body of
 * `slide`, whose text all has a size of its own at that size
 * (`drawnTextSizeOf`), as the stage draws it. They are drawn in the order
 * the slide holds them.
 */
function sizeByTheirText(body: HTMLElement, slide: Node) {
	const sized: Node[] = [];
	bodyOf(slide).descendants((node) => {
		if (node.type.name in SIZED_BY_THEIR_TEXT) sized.push(node);
		return !node.isTextblock;
	});
	const drawn = body.querySelectorAll<HTMLElement>(Object.values(SIZED_BY_THEIR_TEXT).join(", "));
	if (drawn.length !== sized.length) return;
	drawn.forEach((element, index) => {
		const node = sized[index];
		const size = node && drawnTextSizeOf(node);
		if (size !== undefined) element.style.fontSize = `${size}px`;
	});
}

/**
 * A drawing of `slide`, a slide of a live deck: what its body holds, with
 * no notes, on its own colour, with its role-sized text at the size it fits.
 * `serializer` draws each node as the editor does. It is drawn again only for
 * a new `slide` node, which a change to the slide makes, so a change to one
 * slide redraws no other.
 */
export const SlideDrawing = memo(function SlideDrawing({
	slide,
	serializer,
	className,
	inert,
}: {
	slide: Node;
	serializer: DOMSerializer;
	className?: string;
	/**
	 * Out of reach, where something else names the slide and acts on it, as a
	 * thumbnail's button does: hidden from assistive technology, and its links
	 * can't be focused or followed, though it is seen.
	 */
	inert?: boolean;
}) {
	const holder = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = holder.current;
		if (!element) return;
		const body = serializer.serializeNode(bodyOf(slide));
		element.replaceChildren(body);
		if (!(body instanceof HTMLElement)) return;
		sizeByTheirText(body, slide);
		const refit = () => fitSlideText(element, body, slide);
		refit();
		// Its text is measured again once something that changes its size arrives: a font, or an image.
		element.addEventListener("load", refit, true);
		void document.fonts?.ready.then(refit);
		const resized = new ResizeObserver(refit);
		resized.observe(element);
		return () => {
			element.removeEventListener("load", refit, true);
			resized.disconnect();
		};
	}, [slide, serializer]);
	const layout = layoutOf(slide);
	const paint = slidePaintOf(slide);
	return (
		<div
			ref={holder}
			inert={inert}
			data-slide=""
			// As the schema draws a slide: a blank one says no layout.
			data-layout={layout === "blank" ? undefined : layout}
			{...{ [SLIDE_SCHEME_ATTRIBUTE]: paint?.scheme }}
			style={paint ? ({ [SLIDE_PAINT_PROPERTY]: paint.color } as CSSProperties) : undefined}
			className={cn("slide-drawing", className)}
		/>
	);
});
