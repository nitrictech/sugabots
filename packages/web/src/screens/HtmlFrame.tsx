import {
	PAGE_CONTENT_POLICY,
	PAGE_HEIGHT_MESSAGE,
	PAGE_HEIGHT_REPORT,
	type PageTheme,
	pageThemeCss,
	withLeadingTags,
} from "@sugabots/contracts/artifact-pages";
import { cn } from "cn";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type PageAt, usePageAddress } from "@/lib/artifacts.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/**
 * A bot-written HTML page, shown so that nothing in it can act as the viewer.
 *
 * The page is written by a model, and a model can be steered by anything it
 * read, so it is treated as hostile. `sandbox` without `allow-same-origin`
 * gives the frame an opaque origin: its scripts run, but cannot read the app's
 * cookies or storage or call the API as the viewer. `PAGE_CONTENT_POLICY`
 * then stops it loading or sending anything over the network, other than
 * fetching scripts from one CDN.
 *
 * Given `at`, and inside the app, the page is loaded from the installation's
 * content origin when one is set: an origin of its own, apart from the app's
 * site and process. The frame's `csp` attribute asks for the page's policy,
 * which Chromium then holds any document in the frame to, so a page that
 * navigates itself elsewhere is refused there. Otherwise, as in a preview, the
 * page is written into the frame, where it can still navigate itself away.
 * Neither way can stop a running page from leaking what it holds, by
 * navigating or over WebRTC: that is the page's own content, nothing of the
 * viewer's.
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
	at,
	fitHeight = false,
	maxHeight = FIT_HEIGHT_PX.max,
	onPageHeight,
	className,
}: {
	html: string;
	title: string;
	/** Which page this is, to load it from the content origin. */
	at?: PageAt;
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
	const fromContentOrigin = useContext(PagesFromContentOrigin);

	useEffect(() => {
		if (!fitHeight) return;
		function onMessage(event: MessageEvent) {
			// The frame's origin is opaque, so it is told apart by its window.
			if (event.source !== frame.current?.contentWindow) return;
			const reported = (event.data as { type?: unknown; height?: unknown } | null) ?? {};
			if (reported.type !== PAGE_HEIGHT_MESSAGE || typeof reported.height !== "number") return;
			setPageHeight(Math.max(FIT_HEIGHT_PX.min, Math.ceil(reported.height)));
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [fitHeight]);

	useEffect(() => {
		if (fitHeight) onPageHeight?.(pageHeight);
	}, [fitHeight, pageHeight, onPageHeight]);

	const height = fitHeight ? { height: Math.min(pageHeight, maxHeight) } : undefined;
	const classes = cn("block w-full border-0 bg-transparent", className);
	const written = (
		<iframe
			ref={frame}
			title={title}
			srcDoc={withLeadingTags(
				fitHeight ? `${html}${PAGE_HEIGHT_REPORT}` : html,
				`${POLICY_TAG}<style>${pageThemeCss(theme)}</style>`,
			)}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			loading="lazy"
			style={height}
			className={classes}
		/>
	);
	if (!fromContentOrigin || !at) return written;
	return (
		<AddressedPage
			at={at}
			html={html}
			written={written}
			placeholderStyle={height ?? { height: FIT_HEIGHT_PX.min }}
			className={classes}
		>
			{(url) => (
				<iframe
					ref={frame}
					title={title}
					src={`${url}#${encodeURIComponent(JSON.stringify(theme))}`}
					sandbox="allow-scripts"
					referrerPolicy="no-referrer"
					style={height}
					className={classes}
					// Not yet in React's types: Chromium's embedded enforcement.
					{...{ csp: PAGE_CONTENT_POLICY }}
				/>
			)}
		</AddressedPage>
	);
}

/**
 * Whether pages may be loaded from the content origin, which takes the API to
 * hand out their addresses: on in the app, off in a preview with no API.
 */
export const PagesFromContentOrigin = createContext(false);

/**
 * The page at the address the API gives out for it; `written` when no content
 * origin is set. Nothing is shown in its place while the address is asked
 * for, and only a way to ask again if it can't be had, so a page is never
 * shown the weaker way when the stronger one is set up.
 *
 * An address is good for minutes and a new one reloads the frame, so each
 * frame asks for its own once the page comes into view, and again only when
 * the page's content changes.
 */
function AddressedPage({
	at,
	html,
	written,
	placeholderStyle,
	className,
	children,
}: {
	at: PageAt;
	html: string;
	written: ReactNode;
	placeholderStyle: CSSProperties;
	className: string;
	children: (url: string) => ReactNode;
}) {
	const frameId = useId();
	const [shown, setShown] = useState({ html, revision: 0 });
	if (shown.html !== html) setShown({ html, revision: shown.revision + 1 });
	const placeholder = useRef<HTMLDivElement>(null);
	const seen = useSeen(placeholder);
	const address = usePageAddress(at, { load: `${frameId}:${shown.revision}`, enabled: seen });

	if (address.data) return address.data.url === null ? written : children(address.data.url);
	if (address.isError) {
		return (
			<div
				style={placeholderStyle}
				className={cn(className, "flex flex-col items-center justify-center gap-3")}
			>
				<Alert>This page couldn't be loaded.</Alert>
				<Button
					variant="secondary"
					size="sm"
					disabled={address.isFetching}
					onClick={() => void address.refetch()}
				>
					Try again
				</Button>
			</div>
		);
	}
	return <div ref={placeholder} style={placeholderStyle} className={className} />;
}

/** Whether `element` has been on screen; once true, it stays true. */
function useSeen(element: RefObject<HTMLElement | null>): boolean {
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const observed = element.current;
		if (seen || !observed) return;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
		});
		observer.observe(observed);
		return () => observer.disconnect();
	}, [element, seen]);
	return seen;
}

/** How tall a frame fitted to its page may be before it is clipped, so one page never takes over a conversation. */
export const FIT_HEIGHT_PX = { min: 120, max: 560 } as const;

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

/**
 * The app's colour scheme and tokens, read from the root element and read
 * again when the theme there changes.
 */
export function useAppTheme(): PageTheme {
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

const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CONTENT_POLICY}">`;

/** `html` with the policy before anything else in it. */
export function withContentPolicy(html: string): string {
	return withLeadingTags(html, POLICY_TAG);
}
