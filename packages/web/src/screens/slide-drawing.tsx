import {
	bodyOf,
	layoutOf,
	PLACEMENT_ATTRIBUTE,
	placementOf,
	SLIDE_TEXT_STEPS,
} from "@sugabots/contracts/live-slides";
import {
	type Frame,
	placementText,
	roomBottom,
	SLIDE_WIDTH,
} from "@sugabots/contracts/slides-markdown";
import type { DOMSerializer, Node } from "@tiptap/pm/model";
import { cn } from "cn";
import { memo, useLayoutEffect, useRef } from "react";
import { type BoxOfSlide, boxesOf } from "@/lib/deck.ts";

/*
 * A deck's slide drawn read only, as the stage draws it while it is edited:
 * in the strip of slides, in present mode, and wherever a deck is only read.
 * Everything on a slide is sized off its width (see the slide styles in
 * `app.css`), so one drawing serves at any size.
 */

/** The style property, on an element holding a slide, that sets the size its text is drawn at. */
const TEXT_STEP_PROPERTY = "--slide-fit";

/** How tall a slide is for its width. */
const SLIDE_HEIGHT_PER_WIDTH = 9 / 16;

/** Finds a slide's drawn boxes, as the schema draws each (see `SlideBox` in `live-slides.ts`). */
export const DRAWN_BOX = "[data-slide-box]";

/**
 * The attribute a slide's drawn box is drawn with while it is off the slide
 * (`isOffItsSlide`), which the slide styles hide it by. Whoever draws the
 * slide works it out, as the schema can't (see `SlideBox`).
 */
export const REMOVED_ATTRIBUTE = "data-removed";

/** The attribute a slide's drawn box says what it is for in, which its layout's styles place it by. */
export const BOX_ROLE_ATTRIBUTE = "data-box-role";

/**
 * The attributes `box`, one of a slide's boxes, is drawn with, on the stage
 * and in a drawing alike: what it is for, and whether it is off the slide.
 */
export function drawnBoxAttributes({ role, offSlide }: BoxOfSlide): Record<string, string> {
	return {
		...(role ? { [BOX_ROLE_ATTRIBUTE]: role } : {}),
		...(offSlide ? { [REMOVED_ATTRIBUTE]: "" } : {}),
	};
}

/**
 * The custom properties a box of a slide whose boxes were placed by hand is
 * drawn at `frame` by, on the stage and in a drawing alike, in a slide's
 * pixels: `--box-w` for its width and `--box-h` for its height.
 */
export function boxFrameProperties({ x, y, width, height }: Frame): Record<string, string> {
	return {
		"--box-x": String(x),
		"--box-y": String(y),
		"--box-w": String(width),
		"--box-h": String(height),
	};
}

/**
 * Draws the text of the slide whose body is `body`, inside `holder`, at the
 * largest step at which it fits. Answers whether it runs over even at the
 * smallest. Nothing about it is stored: each drawing works it out.
 */
export function fitSlideText(holder: HTMLElement, body: HTMLElement): boolean {
	for (const step of SLIDE_TEXT_STEPS) {
		holder.style.setProperty(TEXT_STEP_PROPERTY, String(step));
		if (fits(body)) return false;
	}
	return true;
}

/**
 * Whether the slide whose body is `body` holds no more than fits it, give or
 * take a pixel of rounding: in the room each box has, for a slide whose boxes
 * were placed by hand, and in the body for one its layout places.
 */
const fits = (body: HTMLElement) =>
	body.parentElement?.hasAttribute(PLACEMENT_ATTRIBUTE) ? everyBoxFits(body) : bodyFits(body);

/**
 * Whether what the body holds is no taller than a slide as wide as it. A
 * body that clips scrolls what runs over; one that doesn't, as the stage's,
 * grows to hold it.
 */
const bodyFits = (body: HTMLElement) =>
	Math.max(body.scrollHeight, body.offsetHeight) <= body.offsetWidth * SLIDE_HEIGHT_PER_WIDTH + 1;

/**
 * Whether what each box shown in the body holds stays within the room the
 * box has on the slide (`roomBottom`). What runs past the foot of its box is
 * drawn there, and only what runs past its room is more than fits. The boxes
 * are measured where they are drawn, so a drag's boxes are measured where the
 * drag has them.
 */
function everyBoxFits(body: HTMLElement): boolean {
	// A slide not drawn, as one hidden, has nothing to measure.
	if (body.offsetWidth === 0) return true;
	const windowPxPerSlidePx = body.offsetWidth / SLIDE_WIDTH;
	const boxes = [...body.querySelectorAll<HTMLElement>(DRAWN_BOX)];
	const frames = boxes.map(
		(box): Frame => ({
			x: box.offsetLeft / windowPxPerSlidePx,
			y: box.offsetTop / windowPxPerSlidePx,
			width: box.offsetWidth / windowPxPerSlidePx,
			height: box.offsetHeight / windowPxPerSlidePx,
		}),
	);
	const shown = boxes.map((box) => !box.hasAttribute(REMOVED_ATTRIBUTE));
	return boxes.every(
		(box, index) =>
			!shown[index] ||
			box.offsetTop + box.scrollHeight <= roomBottom(frames, shown, index) * windowPxPerSlidePx + 1,
	);
}

/**
 * Draws each box of `body`, the drawn body of `slide`, as the stage draws the
 * slide it shows: saying what it is for and whether it is off the slide
 * (`drawnBoxAttributes`), and, on a slide whose boxes were placed by hand,
 * where it was placed (`boxFrameProperties`). A body's boxes hold no boxes, so
 * the boxes drawn in it are its own, in its order.
 */
function drawBoxes(body: HTMLElement, slide: Node) {
	const boxes = boxesOf(slide);
	const placement = placementOf(slide);
	body.querySelectorAll<HTMLElement>(DRAWN_BOX).forEach((drawn, index) => {
		const box = boxes[index];
		if (!box) return;
		for (const [name, value] of Object.entries(drawnBoxAttributes(box))) {
			drawn.setAttribute(name, value);
		}
		const frame = placement?.[index];
		if (!frame) return;
		for (const [name, value] of Object.entries(boxFrameProperties(frame))) {
			drawn.style.setProperty(name, value);
		}
	});
}

/**
 * A drawing of `slide`, a slide of a live deck: what its body holds, with
 * no notes, at the size its text fits, and its boxes where they were placed
 * by hand if they were. `serializer` draws each node as the editor does. It
 * is drawn again only for a new `slide` node, which a change to the slide
 * makes, so a change to one slide redraws no other.
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
		drawBoxes(body, slide);
		const refit = () => fitSlideText(element, body);
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
	const placement = placementOf(slide);
	return (
		<div
			ref={holder}
			inert={hidden}
			data-slide=""
			data-layout={layoutOf(slide)}
			{...(placement ? { [PLACEMENT_ATTRIBUTE]: placementText(placement) } : {})}
			className={cn("slide-drawing", className)}
		/>
	);
});
