import { type RefObject, useEffect, useState } from "react";

/**
 * While `following` is set, keeps `viewport` scrolled to its bottom as what is
 * inside it changes size — a reply growing into view, a code block or an image
 * settling — which no new message or window resize would otherwise catch.
 * `following` is the caller's own record of whether the viewer is at the latest;
 * scrolling away clears it, and this leaves the viewport alone.
 */
export function useFollowContentGrowth(
	viewport: RefObject<HTMLElement | null>,
	following: RefObject<boolean>,
) {
	useEffect(() => {
		const element = viewport.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (following.current) element.scrollTop = element.scrollHeight;
		});
		for (const child of element.children) observer.observe(child);
		return () => observer.disconnect();
	});
}

/**
 * Keeps what is at the foot of `viewport` at its foot when the viewport itself
 * changes height, as when a phone's keyboard opens under the composer: the
 * messages move up with the composer instead of sliding under it.
 *
 * Call it from the viewport's ref callback, which runs when the element mounts,
 * and return what it returns so React stops watching when the element goes. An
 * effect would either watch again on every render or, keyed to the ref, never
 * see an element that mounts after the first render.
 */
export function keepFootInView(viewport: HTMLElement): () => void {
	if (typeof ResizeObserver === "undefined") return () => {};
	let previousHeight = viewport.clientHeight;
	const observer = new ResizeObserver(() => {
		viewport.scrollTop += previousHeight - viewport.clientHeight;
		previousHeight = viewport.clientHeight;
	});
	observer.observe(viewport);
	return () => observer.disconnect();
}

/** How many frames a log waits to reach its latest before it is shown wherever it is. */
const SETTLE_FRAMES = 30;

/**
 * Whether `viewport`, opened at its latest once `ready`, has got there. Until
 * then it scrolls there again each frame, as what is in it settles: Safari can
 * draw a chat's first frames before scrolling it, showing its top for a moment.
 * It counts as settled once the viewer stops `following`, or after a moment
 * regardless, so a log never stays hidden.
 */
export function useSettledAtLatest(
	viewport: RefObject<HTMLElement | null>,
	following: RefObject<boolean>,
	ready: boolean,
): boolean {
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (settled || !ready) return;
		let framesLeft = SETTLE_FRAMES;
		let frame = requestAnimationFrame(function check() {
			const element = viewport.current;
			if (!element) return;
			const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 1;
			if (atLatest || !following.current || framesLeft === 0) {
				setSettled(true);
				return;
			}
			element.scrollTop = element.scrollHeight;
			framesLeft -= 1;
			frame = requestAnimationFrame(check);
		});
		return () => cancelAnimationFrame(frame);
	}, [settled, ready, viewport, following]);
	return settled;
}
