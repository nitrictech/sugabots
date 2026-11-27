import { backgroundOf, bodyOf, layoutOf, SLIDE_TEXT_STEPS } from "@sugabots/contracts/live-slides";
import { type Frame, roomBottom } from "@sugabots/contracts/slide-geometry";
import { TEXT_STYLE } from "@sugabots/contracts/slide-text-style";
import type { DOMSerializer, Node } from "@tiptap/pm/model";
import { cn } from "cn";
import { type CSSProperties, memo, useLayoutEffect, useRef } from "react";
import { boxesOf } from "@/lib/deck.ts";

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

/** Finds a slide's drawn boxes, as the schema draws each (see `SlideBox` in `live-slides.ts`). */
export const DRAWN_BOX = "[data-slide-box]";

/** The elements a slide's lines of text are drawn as: its paragraphs and headings. */
const DRAWN_LINES = "p, h1, h2, h3, h4, h5, h6";

/**
 * The size `line`, a paragraph or heading, is drawn at when every bit of its
 * text has a size of its own (see `slide-text-style.ts`): the largest of
 * them, in a slide's pixels. A line is as tall as the size its own element is
 * drawn at, whatever its text's, so a line of text smaller than the slide
 * styles draw it would otherwise be spaced as if it were their size.
 * `undefined` for a line holding no text, or any text sized by the slide
 * styles.
 */
export function ownTextSizeOf(line: Node): number | undefined {
	let largest: number | undefined;
	let styled = true;
	line.forEach((inline) => {
		if (!inline.isText) return;
		const size = sizeOfText(inline);
		if (size === undefined) styled = false;
		else largest = Math.max(largest ?? 0, size);
	});
	return styled ? largest : undefined;
}

/** The size `text`, a run of a slide's text, has of its own, if it has one. */
function sizeOfText(text: Node): number | undefined {
	const size: unknown = text.marks.find((mark) => mark.type.name === TEXT_STYLE)?.attrs.fontSize;
	return typeof size === "number" ? size : undefined;
}

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
	const stepping = boxesOf(slide).map(({ node }) => holdsTextSizedByStyles(node));
	for (const step of SLIDE_TEXT_STEPS) {
		holder.style.setProperty(TEXT_STEP_PROPERTY, String(step));
		if (everyBoxFits(body, stepping)) return false;
	}
	return true;
}

/**
 * Whether what each box of `body` that `stepping` says steps holds stays
 * within the room the box has on the slide (`roomBottom`). What runs past
 * the foot of its box is drawn there, and only what runs past its room is
 * more than fits. The boxes are measured where they are drawn, in the
 * slide's own pixels, so a drag's boxes are measured where the drag has
 * them.
 */
function everyBoxFits(body: HTMLElement, stepping: readonly boolean[]): boolean {
	// A slide not drawn, as one hidden, has nothing to measure.
	if (body.offsetWidth === 0) return true;
	const boxes = [...body.querySelectorAll<HTMLElement>(DRAWN_BOX)];
	const frames = boxes.map(
		(box): Frame => ({
			x: box.offsetLeft,
			y: box.offsetTop,
			width: box.offsetWidth,
			height: box.offsetHeight,
		}),
	);
	return boxes.every(
		(box, index) =>
			!stepping[index] || box.offsetTop + box.scrollHeight <= roomBottom(frames, index) + 1,
	);
}

/**
 * Draws each line of `body`, the drawn body of `slide`, whose text all has a
 * size of its own at that size (`ownTextSizeOf`), as the stage draws it. The
 * lines are drawn in the order the slide holds them.
 */
function sizeLinesByTheirText(body: HTMLElement, slide: Node) {
	const lines: Node[] = [];
	bodyOf(slide).descendants((node) => {
		if (node.type.name === "paragraph" || node.type.name === "heading") lines.push(node);
		return !node.isTextblock;
	});
	const drawn = body.querySelectorAll<HTMLElement>(DRAWN_LINES);
	if (drawn.length !== lines.length) return;
	drawn.forEach((element, index) => {
		const line = lines[index];
		const size = line && ownTextSizeOf(line);
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
	hidden,
}: {
	slide: Node;
	serializer: DOMSerializer;
	className?: string;
	/**
	 * Out of reach, where something else names the slide and acts on it, as a
	 * thumbnail's button does: hidden from assistive technology, and its links
	 * can't be focused or followed.
	 */
	hidden?: boolean;
}) {
	const holder = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = holder.current;
		if (!element) return;
		const body = serializer.serializeNode(bodyOf(slide));
		element.replaceChildren(body);
		if (!(body instanceof HTMLElement)) return;
		sizeLinesByTheirText(body, slide);
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
	const background = backgroundOf(slide);
	return (
		<div
			ref={holder}
			inert={hidden}
			data-slide=""
			// As the schema draws a slide: a blank one says no layout.
			data-layout={layout === "blank" ? undefined : layout}
			style={background ? ({ [SLIDE_PAINT_PROPERTY]: background } as CSSProperties) : undefined}
			className={cn("slide-drawing", className)}
		/>
	);
});
