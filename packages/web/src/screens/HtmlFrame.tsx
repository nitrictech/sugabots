import { cn } from "cn";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * A bot-written HTML page, shown so that nothing in it can act as the viewer.
 *
 * The page is written by a model, and a model can be steered by anything it
 * read, so it is treated as hostile. `sandbox` without `allow-same-origin`
 * gives the frame an opaque origin: its scripts run, but cannot read the app's
 * cookies or storage or call the API as the viewer. The policy below then
 * stops it loading or sending anything over the network, other than fetching
 * scripts from one CDN. A frame can still navigate itself, which could carry
 * what the page holds out in a URL; that is the page's own content, nothing
 * of the viewer's.
 *
 * The page is given the app's colour tokens and theme, on a transparent
 * ground, so one that uses them looks like part of the app (see
 * `FRAME_TOKENS`).
 *
 * With `fitHeight`, the frame grows to the page's height as the page reports
 * it, up to `maxHeight`; `onPageHeight` hears that height.
 */
export function HtmlFrame({
	html,
	title,
	fitHeight = false,
	maxHeight = FIT_HEIGHT_PX.max,
	onPageHeight,
	className,
}: {
	html: string;
	title: string;
	fitHeight?: boolean;
	/** In pixels; unbounded with `Infinity`. */
	maxHeight?: number;
	/** In pixels. */
	onPageHeight?: (height: number) => void;
	className?: string;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [pageHeight, setPageHeight] = useState<number>(FIT_HEIGHT_PX.min);
	const theme = useAppTheme();

	useEffect(() => {
		if (!fitHeight) return;
		function onMessage(event: MessageEvent) {
			// The frame's origin is opaque, so it is told apart by its window.
			if (event.source !== frame.current?.contentWindow) return;
			const reported = (event.data as { type?: unknown; height?: unknown } | null) ?? {};
			if (reported.type !== HEIGHT_MESSAGE || typeof reported.height !== "number") return;
			setPageHeight(Math.max(FIT_HEIGHT_PX.min, Math.ceil(reported.height)));
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [fitHeight]);

	useEffect(() => {
		if (fitHeight) onPageHeight?.(pageHeight);
	}, [fitHeight, pageHeight, onPageHeight]);

	const page = fitHeight ? withHeightReport(html) : html;
	return (
		<iframe
			ref={frame}
			title={title}
			srcDoc={withLeadingTags(page, `${POLICY_TAG}${appThemeSheet(theme)}`)}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			loading="lazy"
			style={fitHeight ? { height: Math.min(pageHeight, maxHeight) } : undefined}
			className={cn("block w-full border-0 bg-transparent", className)}
		/>
	);
}

/** How tall a frame fitted to its page may be before it is clipped, so one page never takes over a conversation. */
export const FIT_HEIGHT_PX = { min: 120, max: 560 } as const;

const HEIGHT_MESSAGE = "sugabots:frame-height";

/**
 * The app's tokens a page is given as CSS variables of the same names, which
 * the artifact tools tell bots about. Each is copied as the stylesheet
 * declares it, `light-dark()` and all, so it follows the frame's
 * `color-scheme`, which is the app's.
 */
export const FRAME_TOKENS = [
	"--background",
	"--card",
	"--panel",
	"--chip",
	"--hover",
	"--foreground",
	"--body-foreground",
	"--muted-foreground",
	"--subtle-foreground",
	"--border",
	"--border-strong",
	"--primary",
	"--primary-foreground",
	"--link",
	"--success-text",
	"--destructive-text",
	"--warning",
	"--font-sans",
	"--font-mono",
] as const;

interface AppTheme {
	colorScheme: string;
	tokens: string;
}

/**
 * The app's colour scheme and tokens, read from the root element and read
 * again when the theme there changes.
 */
function useAppTheme(): AppTheme {
	const colorScheme = useSyncExternalStore(onRootThemeChange, rootColorScheme);
	const [tokens] = useState(rootTokens);
	return { colorScheme, tokens };
}

function onRootThemeChange(notify: () => void): () => void {
	const observer = new MutationObserver(notify);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => observer.disconnect();
}

function rootColorScheme(): string {
	return getComputedStyle(document.documentElement).colorScheme || "dark";
}

function rootTokens(): string {
	const style = getComputedStyle(document.documentElement);
	return FRAME_TOKENS.map((token) => `${token}: ${style.getPropertyValue(token).trim()};`).join(
		" ",
	);
}

/**
 * A stylesheet giving a page the app's tokens and theme. A frame is only
 * see-through when its `color-scheme` matches the app's, so that is set too.
 * It goes before the page's own styles, so a page can set its own.
 */
function appThemeSheet({ colorScheme, tokens }: AppTheme): string {
	return `<style>:root { color-scheme: ${colorScheme}; ${tokens} } html, body { background: transparent; } body { margin: 0; color: var(--body-foreground); font-family: var(--font-sans); }</style>`;
}

/** Inline code and styles, scripts from one CDN, and data the page embeds; nothing else fetched. */
export const FRAME_CONTENT_POLICY = [
	"default-src 'none'",
	"script-src 'unsafe-inline' https://cdn.jsdelivr.net",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"form-action 'none'",
].join("; ");

const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CONTENT_POLICY}">`;

/**
 * Tells the parent the page's height whenever it changes. The page could post
 * the same message itself, which can only resize its own frame.
 */
const HEIGHT_REPORT = `<script>new ResizeObserver(() => parent.postMessage({ type: "${HEIGHT_MESSAGE}", height: document.documentElement.scrollHeight }, "*")).observe(document.documentElement);</script>`;

/** `html` with the height report after it, where the page's own document is already parsed. */
function withHeightReport(html: string): string {
	return `${html}${HEIGHT_REPORT}`;
}

/** `html` with the policy before anything else in it. */
export function withContentPolicy(html: string): string {
	return withLeadingTags(html, POLICY_TAG);
}

/**
 * `html` with `tags` before any of the page's own, so a policy among them
 * applies before anything else: the parser puts leading `<meta>` and `<style>`
 * tags in the head it opens. It is not looked for a `<head>` to go in, since
 * the page could hide one in a comment. They go after a doctype rather than
 * before, which would put the page in quirks mode.
 */
function withLeadingTags(html: string, tags: string): string {
	const doctype = /^<!doctype[^>]*>/i.exec(html.trimStart());
	if (!doctype) return `${tags}${html}`;
	const rest = html.trimStart().slice(doctype[0].length);
	return `${doctype[0]}${tags}${rest}`;
}
