/*
 * What jsdom does not have and the web app needs.
 *
 * Mostly measurement: the primitives ask how big something is, and where the
 * pointer is, before deciding how to draw it — and jsdom says everything is
 * zero by zero and has no pointer capture at all. Without these a select or a
 * menu never opens, which reads as a bug in the component rather than in the
 * environment.
 */

import { vi } from "vitest";

// jsdom cannot paint canvases; browser stories exercise the real renderer.
vi.mock("hashvatar", () => ({ renderHashvatar: vi.fn(() => () => {}) }));

if (!("ResizeObserver" in globalThis)) {
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
}

if (!("DOMRect" in globalThis)) {
	globalThis.DOMRect = class {
		constructor(
			public x = 0,
			public y = 0,
			public width = 0,
			public height = 0,
		) {}
		get top() {
			return this.y;
		}
		get left() {
			return this.x;
		}
		get right() {
			return this.x + this.width;
		}
		get bottom() {
			return this.y + this.height;
		}
		toJSON() {
			return this;
		}
	} as unknown as typeof DOMRect;
}

/*
 * The router restores scroll position on navigation, which jsdom has no
 * implementation for and complains about once per route change. The complaint
 * is noise, not a finding.
 */
window.scrollTo = () => {};

/*
 * Pointer capture, which the select uses to decide whether a press became
 * a drag. jsdom implements the events but not the capture API.
 */
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
	Element.prototype.setPointerCapture = () => {};
	Element.prototype.releasePointerCapture = () => {};
}

// An open listbox scrolls its selected option into view.
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

// The scroll area waits for the viewport's animations before measuring it.
if (!Element.prototype.getAnimations) {
	Element.prototype.getAnimations = () => [];
}
