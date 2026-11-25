import {
	draggable,
	dropTargetForElements,
	type ElementDropTargetEventBasePayload,
	monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { Node } from "@tiptap/pm/model";
import { type RefObject, useEffect, useEffectEvent, useState } from "react";

/*
 * Moving a slide to a new place by dragging its thumbnail up or down the
 * strip, with the browser's own drag and drop.
 *
 * A slide has no lasting id, and others may change the deck while a slide is
 * dragged, so a drag carries the slide's node rather than its place. A node
 * is never changed, only replaced, and a slide nobody changes stays the same
 * node in every later deck: when the slide is dropped it is looked for among
 * the slides then, and the drop does nothing once somebody has changed it or
 * removed it.
 */

/**
 * Lets the thumbnails in `list`, inside the strip `strip`, be dragged to a new
 * place among `slides` while `enabled`. Once one is dropped in the strip,
 * `onMove` is given where its slide is and where it is to stand.
 *
 * Answers which slide is being dragged, and while it is over the strip and a
 * drop would move it, the gap a drop line marks: the number of thumbnails
 * before it.
 */
export function useSlideReordering({
	strip,
	list,
	slides,
	enabled,
	onMove,
}: {
	strip: RefObject<HTMLElement | null>;
	/** The thumbnails, in order, as its children. */
	list: RefObject<HTMLElement | null>;
	slides: readonly Node[];
	enabled: boolean;
	onMove: (from: number, to: number) => void;
}): { dragged: Node | undefined; dropGap: number | undefined } {
	const [dragged, setDragged] = useState<Node>();
	const [gap, setGap] = useState<number>();
	const isHere = useEffectEvent(
		(slide: Node | undefined) => slide !== undefined && slides.includes(slide),
	);
	const drop = useEffectEvent((slide: Node | undefined, y: number) => {
		const from = slide ? slides.indexOf(slide) : -1;
		const thumbnails = list.current;
		if (from === -1 || !thumbnails) return;
		const to = placeFor(from, gapAt(thumbnails, y));
		if (to !== undefined) onMove(from, to);
	});
	useEffect(() => {
		const [element, thumbnails] = [strip.current, list.current];
		if (!enabled || !element || !thumbnails) return;
		const follow = ({ location }: ElementDropTargetEventBasePayload) =>
			setGap(gapAt(thumbnails, location.current.input.clientY));
		const end = () => {
			setDragged(undefined);
			setGap(undefined);
		};
		return combine(
			monitorForElements({
				canMonitor: ({ source }) => slideIn(source.data) !== undefined,
				onDragStart: ({ source }) => setDragged(slideIn(source.data)),
				onDrop: end,
			}),
			dropTargetForElements({
				element,
				canDrop: ({ source }) => isHere(slideIn(source.data)),
				onDragEnter: follow,
				onDrag: follow,
				onDragLeave: () => setGap(undefined),
				onDrop: ({ source, location }) =>
					drop(slideIn(source.data), location.current.input.clientY),
			}),
			autoScrollForElements({
				element,
				canScroll: ({ source }) => slideIn(source.data) !== undefined,
				getAllowedAxis: () => "vertical",
			}),
			// Stopped during a drag, as when the window narrows to a phone's, its end isn't heard.
			end,
		);
	}, [enabled, strip, list]);
	const dragging = dragged !== undefined;
	useEffect(() => {
		if (!dragging) return;
		return keepDragFromPage();
	}, [dragging]);
	const from = dragged ? slides.indexOf(dragged) : -1;
	const moves = from !== -1 && gap !== undefined && placeFor(from, gap) !== undefined;
	return { dragged, dropGap: moves ? gap : undefined };
}

/**
 * Lets `frame`, the frame of the thumbnail showing `slide`, be dragged while
 * `enabled`, picked up by `cover`, what selects the slide across it, and not
 * by the menu or the faces of people on top.
 */
export function useThumbnailDragging({
	frame,
	cover,
	slide,
	enabled,
}: {
	frame: RefObject<HTMLElement | null>;
	cover: RefObject<HTMLElement | null>;
	slide: Node;
	enabled: boolean;
}): void {
	useEffect(() => {
		const [element, dragHandle] = [frame.current, cover.current];
		if (!enabled || !element || !dragHandle) return;
		return draggable({ element, dragHandle, getInitialData: () => ({ slide }) });
	}, [frame, cover, slide, enabled]);
}

/** The slide a drag carries, when it is a thumbnail's (see `useThumbnailDragging`). */
const slideIn = (data: Record<string, unknown>): Node | undefined =>
	data.slide instanceof Node ? data.slide : undefined;

/**
 * The gap in `list` nearest `y`, as the number of thumbnails before it: those
 * whose middle is above `y`. Read from the page as it is drawn now, so it
 * counts the thumbnails of the deck as it is now.
 */
function gapAt(list: HTMLElement, y: number): number {
	return [...list.children].filter((thumbnail) => {
		const { top, height } = thumbnail.getBoundingClientRect();
		return y > top + height / 2;
	}).length;
}

/**
 * Where the slide at `from` is to stand once dropped in `gap`, or `undefined`
 * when the gap is just before or after it, which would leave it where it is.
 */
function placeFor(from: number, gap: number): number | undefined {
	if (gap === from || gap === from + 1) return undefined;
	return gap > from ? gap - 1 : gap;
}

/**
 * Keeps a slide's drag from the rest of the page until it ends, so only the
 * strip takes it: the editor would offer the stage for it, drawing its drop
 * line in the text, and areas that take files would look into it. And where
 * the strip doesn't take it, it can't be dropped at all, so the browser drops
 * nothing by itself: it would drop text into the editor's text, and the drag
 * library gives a drag a placeholder text on Android, where none starts
 * without. The library listens on the window, ahead of this, so it still
 * follows the drag, and has accepted it already where the strip takes it.
 */
function keepDragFromPage(): () => void {
	const stop = (event: DragEvent) => event.stopPropagation();
	const refuse = (event: DragEvent) => {
		event.stopPropagation();
		if (event.defaultPrevented || !event.dataTransfer) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "none";
	};
	const listeners = [
		["dragenter", refuse],
		["dragover", refuse],
		["dragleave", stop],
		["drop", stop],
	] as const;
	for (const [type, listener] of listeners) {
		document.addEventListener(type, listener, { capture: true });
	}
	return () => {
		for (const [type, listener] of listeners) {
			document.removeEventListener(type, listener, { capture: true });
		}
	};
}
