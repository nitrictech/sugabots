import { SUGGESTED_DELETION } from "@sugabots/contracts/live-document";
import {
	isRemovedBox,
	layoutOf,
	placementOf,
	placementProperties,
	SLIDE_TEXT_STEPS,
} from "@sugabots/contracts/live-slides";
import {
	type BoxRole,
	type Frame,
	placementText,
	roomBottom,
	SLIDE_BOX_ROLES,
	SLIDE_WIDTH,
} from "@sugabots/contracts/slides-markdown";
import type { DOMSerializer, Node } from "@tiptap/pm/model";
import { cn } from "cn";
import { type CSSProperties, memo, useLayoutEffect, useRef } from "react";

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

/**
 * The attribute a slide whose boxes were placed by hand is drawn with, on
 * the element holding its frame, as the editor draws it (see `Slide` in
 * `live-slides.ts`), and which the placed slide's styles go by.
 */
export const PLACED_ATTRIBUTE = "data-placement";

/**
 * The attribute a slide's drawn box is drawn with while it is off the slide
 * (`isRemovedBox`), which the slide styles hide it by. Whoever draws the
 * slide works it out, as the schema can't (see `SlideBox`).
 */
export const REMOVED_ATTRIBUTE = "data-removed";

/**
 * Draws the text of the slide whose frame is `body`, inside `holder`, at the
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
 * Whether the slide whose frame is `body` holds no more than fits it, give or
 * take a pixel of rounding: in the room each box has, for a slide whose boxes
 * were placed by hand, and in the frame for one its layout places.
 */
const fits = (body: HTMLElement) =>
	body.parentElement?.hasAttribute(PLACED_ATTRIBUTE) ? everyBoxFits(body) : frameFits(body);

/**
 * Whether what the frame holds is no taller than a slide as wide as it. A
 * frame that clips scrolls what runs over; one that doesn't, as the stage's,
 * grows to hold it.
 */
const frameFits = (body: HTMLElement) =>
	Math.max(body.scrollHeight, body.offsetHeight) <= body.offsetWidth * SLIDE_HEIGHT_PER_WIDTH + 1;

/**
 * Whether what each box shown in the frame holds stays within the room the
 * box has on the slide (`roomBottom`). What runs past the foot of its box is
 * drawn there, and only what runs past its room is more than fits. The boxes
 * are measured where they are drawn, so a drag's boxes are measured where the
 * drag has them.
 */
function everyBoxFits(body: HTMLElement): boolean {
	// A slide not drawn, as one hidden, has nothing to measure.
	if (body.offsetWidth === 0) return true;
	// How many of the window's pixels a pixel of the slide is drawn as.
	const slidePixel = body.offsetWidth / SLIDE_WIDTH;
	const boxes = [...body.querySelectorAll<HTMLElement>("[data-slide-box]")];
	const frames = boxes.map(
		(box): Frame => ({
			x: box.offsetLeft / slidePixel,
			y: box.offsetTop / slidePixel,
			w: box.offsetWidth / slidePixel,
			h: box.offsetHeight / slidePixel,
		}),
	);
	const shown = boxes.map((box) => !box.hasAttribute(REMOVED_ATTRIBUTE));
	return boxes.every(
		(box, index) =>
			!shown[index] ||
			box.offsetTop + box.scrollHeight <= roomBottom(frames, shown, index) * slidePixel + 1,
	);
}

/** The attribute a slide's drawn box says what it is for in, which its layout's styles place it by. */
export const BOX_ROLE_ATTRIBUTE = "data-box-role";

/**
 * What each of a slide's boxes is for, in order: its layout's roles
 * (`SLIDE_BOX_ROLES`) taken in turn by the boxes nobody proposes removing.
 * While a new layout waits as a suggestion, the slide is drawn in it, and
 * its frame holds the boxes the layout would remove beside those it keeps
 * and adds. A box proposed for removal, or one past the layout's last, is
 * for nothing.
 */
export function rolesOfBoxes(slide: Node): (BoxRole | undefined)[] {
	const roles = SLIDE_BOX_ROLES[layoutOf(slide)];
	let taken = 0;
	return slide.child(0).children.map((box) => {
		const removing = box.marks.some((mark) => mark.type.name === SUGGESTED_DELETION);
		return removing ? undefined : roles[taken++];
	});
}

/**
 * Says on each box of `body`, the drawn frame of `slide`, what it is for, and
 * whether it is off the slide, as the stage says them on the slide it shows.
 * A frame's boxes hold no boxes, so the boxes drawn in it are its own, in its
 * order.
 */
function sayBoxRolesAndRemovals(body: HTMLElement, slide: Node) {
	const roles = rolesOfBoxes(slide);
	const boxes = slide.child(0).children;
	body.querySelectorAll("[data-slide-box]").forEach((drawn, index) => {
		const role = roles[index];
		if (role) drawn.setAttribute(BOX_ROLE_ATTRIBUTE, role);
		const box = boxes[index];
		if (box && isRemovedBox(box)) drawn.setAttribute(REMOVED_ATTRIBUTE, "");
	});
}

/**
 * A drawing of `slide`, a slide of a live deck: what its frame holds, with
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
		const body = serializer.serializeNode(slide.child(0));
		element.replaceChildren(body);
		if (!(body instanceof HTMLElement)) return;
		sayBoxRolesAndRemovals(body, slide);
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
			// `PLACED_ATTRIBUTE`, and the frames the placed slide's styles draw its boxes at, as the editor gives them.
			data-placement={placement ? placementText(placement) : undefined}
			style={placement ? (placementProperties(placement) as CSSProperties) : undefined}
			className={cn("slide-drawing", className)}
		/>
	);
});
