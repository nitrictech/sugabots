import { useEffect } from "react";

/** Differences in scale below this are rounding, not the viewer zooming in. */
const ZOOMED_IN_BEYOND = 1.01;

/**
 * Keeps `--visible-height` on the root element at the height of the part of
 * the page the browser shows. iOS Safari lays a page out at full height with
 * the keyboard open: the keyboard covers the foot of the page, and the page
 * slides up to keep the focused field in view, so a composer at the foot rises
 * over the messages rather than the messages rising with it. Sized to what is
 * visible, the app ends at the keyboard instead.
 *
 * Left unset while the viewer has pinched in, when the visible part is small
 * because it is magnified, not because anything covers the page.
 */
export function useVisibleHeight() {
	useEffect(() => {
		const visual = window.visualViewport;
		if (!visual) return;
		const root = document.documentElement;

		function update() {
			if (!visual || visual.scale > ZOOMED_IN_BEYOND) {
				root.style.removeProperty("--visible-height");
				return;
			}
			root.style.setProperty("--visible-height", `${visual.height}px`);
			// Once the app fits what is visible, the slide up would only hide its top.
			if (window.scrollY !== 0) window.scrollTo(0, 0);
		}

		update();
		visual.addEventListener("resize", update);
		visual.addEventListener("scroll", update);
		return () => {
			visual.removeEventListener("resize", update);
			visual.removeEventListener("scroll", update);
			root.style.removeProperty("--visible-height");
		};
	}, []);
}
