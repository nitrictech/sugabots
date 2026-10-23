import type { ReactNode } from "react";

/**
 * The system a visitor is on, so the screenshots and the demo video show the
 * window's title bar as theirs draws it: macOS's traffic lights, Windows'
 * caption buttons, or for anything else, GNOME's round buttons. Each capture
 * is made for all three, `one-thread-mac.webp` and so on.
 */
export type VisitorOs = "mac" | "windows" | "linux";

const systems: readonly VisitorOs[] = ["mac", "windows", "linux"];

/**
 * Marks the page with the visitor's system before it's first drawn, so the
 * matching captures show from the start: run inline in the page's head.
 */
export const VISITOR_OS_SCRIPT = `(() => {
	const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent;
	document.documentElement.dataset.os = /Mac|iPhone|iPad|iOS/i.test(platform) ? "mac" : /Win/i.test(platform) ? "windows" : "linux";
})();`;

/** The visitor's system, as the head's script marked it; macOS on the server, or before it has run. */
export function visitorOs(): VisitorOs {
	if (typeof document === "undefined") return "mac";
	const marked = document.documentElement.dataset.os;
	return systems.find((system) => system === marked) ?? "mac";
}

/** `/screenshots/one-thread.webp` as the capture for `os`: `/screenshots/one-thread-mac.webp`. */
export function captureFor(path: string, os: VisitorOs): string {
	return path.replace(/(\.\w+)$/, `-${os}$1`);
}

/**
 * Each system's version of something, of which the page shows only the
 * visitor's, by the head's mark: a hidden lazy image is never fetched, so a
 * visitor downloads their own captures alone.
 */
export function ForVisitorOs({ children }: { children: (os: VisitorOs) => ReactNode }) {
	return systems.map((os) => (
		<span key={os} data-for-os={os} className="contents">
			{children(os)}
		</span>
	));
}
