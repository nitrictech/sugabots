import { throttle } from "es-toolkit";
import { type RefObject, useEffect } from "react";
import type { FaceControls } from "./face-rig.ts";

/** How many face-widths away something must be for the eyes to look all the way to it. */
const WATCHING_REACH = 2.5;
/**
 * The least time between the eyes' jumps to what they watch. Eyes move in
 * quick jumps rather than gliding, so following the pointer this way looks
 * natural, and each jump is one short animation rather than one a frame.
 */
const JUMP_INTERVAL_MS = 100;

/**
 * Turns the face's eyes to the pointer as it moves and to where someone types,
 * as `watch` asks, while `allowed`. `box` is the element the face fills.
 */
export function useWatching(
	face: FaceControls,
	box: RefObject<HTMLElement | null>,
	watch: { pointer: boolean; typing: boolean },
	allowed: boolean,
): void {
	const { pointer, typing } = watch;
	useEffect(() => {
		if (!allowed || (!pointer && !typing)) return;
		const lookToward = ({ x, y }: { x: number; y: number }) => {
			const rect = box.current?.getBoundingClientRect();
			// A face laid out at no size, such as one hidden on a narrow screen, has nowhere to look from.
			if (!rect || rect.width === 0) return;
			const reach = rect.width * WATCHING_REACH;
			face.lookAt(
				...withinUnitCircle(
					(x - (rect.left + rect.width / 2)) / reach,
					(y - (rect.top + rect.height / 2)) / reach,
				),
			);
			face.markWatched();
		};
		// Looks at once, then at most every JUMP_INTERVAL_MS at the latest point.
		const jumpTo = throttle(lookToward, JUMP_INTERVAL_MS);
		const followPointer = (event: PointerEvent) => jumpTo({ x: event.clientX, y: event.clientY });
		const followTyping = (event: Event) => {
			if (event.target instanceof Element) jumpTo(typingPoint(event.target));
		};
		if (pointer) window.addEventListener("pointermove", followPointer, { passive: true });
		// Capturing, so typing is seen even where something stops the event on its way up.
		if (typing) window.addEventListener("input", followTyping, { capture: true });
		return () => {
			jumpTo.cancel();
			window.removeEventListener("pointermove", followPointer);
			window.removeEventListener("input", followTyping, { capture: true });
		};
	}, [face, box, pointer, typing, allowed]);
}

/**
 * Where on the page someone is typing into `field`: the caret, where the page
 * can say (in editable text), else the middle of the field.
 */
function typingPoint(field: Element): { x: number; y: number } {
	const selection = window.getSelection();
	const caret =
		selection && selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null;
	if (
		caret &&
		(caret.width > 0 || caret.height > 0) &&
		field.contains(selection?.anchorNode ?? null)
	) {
		return { x: caret.left, y: caret.top + caret.height / 2 };
	}
	const box = field.getBoundingClientRect();
	return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** The point, pulled in to distance 1 from the middle if it lies further out. */
function withinUnitCircle(x: number, y: number): [number, number] {
	const distance = Math.max(1, Math.hypot(x, y));
	return [x / distance, y / distance];
}
