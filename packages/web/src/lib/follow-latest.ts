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
