import { type RefObject, useEffect } from "react";

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
 */
export function useKeepFootInView(viewport: RefObject<HTMLElement | null>) {
	useEffect(() => {
		const element = viewport.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		let previousHeight = element.clientHeight;
		const observer = new ResizeObserver(() => {
			element.scrollTop += previousHeight - element.clientHeight;
			previousHeight = element.clientHeight;
		});
		observer.observe(element);
		return () => observer.disconnect();
	});
}
