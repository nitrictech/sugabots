import { layoutOf } from "@sugabots/contracts/live-slides";
import type { DOMSerializer, Node } from "@tiptap/pm/model";
import { cn } from "cn";
import { memo, useLayoutEffect, useRef } from "react";

/*
 * A deck's slide drawn read only, as the stage draws it while it is edited:
 * in the strip of slides, in present mode, and wherever a deck is only read.
 * Everything on a slide is sized off its width (see the slide styles in
 * `app.css`), so one drawing serves at any size.
 */

/**
 * The sizes a slide's text is drawn at, as parts of its full size, largest
 * first: the first at which it fits the slide is the one it is drawn at.
 */
const TEXT_STEPS = [1, 0.9, 0.8, 0.7] as const;

/** The style property, on an element holding a slide, that sets the size its text is drawn at. */
const TEXT_STEP_PROPERTY = "--slide-fit";

/** How tall a slide is for its width. */
const SLIDE_HEIGHT_PER_WIDTH = 9 / 16;

/**
 * Draws the text of the slide whose frame is `body`, inside `holder`, at the
 * largest step at which it fits the frame. Answers whether it runs over even
 * at the smallest. Nothing about it is stored: each drawing works it out.
 */
export function fitSlideText(holder: HTMLElement, body: HTMLElement): boolean {
	for (const step of TEXT_STEPS) {
		holder.style.setProperty(TEXT_STEP_PROPERTY, String(step));
		if (fits(body)) return false;
	}
	return true;
}

/**
 * Whether what the frame holds is no taller than a slide as wide as it, give
 * or take a pixel of rounding. A frame that clips scrolls what runs over; one
 * that doesn't, as the stage's, grows to hold it.
 */
const fits = (body: HTMLElement) =>
	Math.max(body.scrollHeight, body.offsetHeight) <= body.offsetWidth * SLIDE_HEIGHT_PER_WIDTH + 1;

/**
 * A drawing of `slide`, a slide of a live deck: what its frame holds, with
 * no notes, at the size its text fits. `serializer` draws each node as the
 * editor does. It is drawn again only for a new `slide` node, which a change
 * to the slide makes, so a change to one slide redraws no other.
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
		const body = serializer.serializeNode(slide.child(0));
		element.replaceChildren(body);
		if (!(body instanceof HTMLElement)) return;
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
	return (
		<div
			ref={holder}
			inert={hidden}
			data-slide=""
			data-layout={layoutOf(slide)}
			className={cn("slide-drawing", className)}
		/>
	);
});
