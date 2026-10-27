import type RFB from "@novnc/novnc";
import { useEffect, useRef } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { IDLE_TIMEOUT_MINUTES } from "@/lib/desktop.ts";
import { Button } from "@/ui/button.tsx";

export type Standing = "connecting" | "connected" | "ended" | "idle";

/**
 * A display over VNC from the API's WebSocket at `url`, filling its parent,
 * scaled to fit unless not `scaled`, connected for as long as it's mounted,
 * and giving `onScreen` what it draws once connected. Unless `viewOnly`, it
 * takes the person's mouse and keys, and shares a clipboard with them: what
 * the display's apps copy is passed to `onClipboard`, `clipboard` is put on
 * the display's, and the shortcut to paste reads the person's own clipboard
 * first. On a Mac, ⌘ shortcuts for copying, cutting, pasting, selecting all
 * and undoing become the Ctrl ones Linux apps know. The desktop server, not
 * VNC, sizes the display to its window, so it fits whether the person is in
 * control or not.
 */
export function VncView({
	url,
	viewOnly,
	scaled = true,
	onStanding,
	onScreen,
	clipboard,
	onClipboard,
}: {
	url: string;
	/** Shows the display without sending input. The API enforces it either way. */
	viewOnly: boolean;
	scaled?: boolean;
	onStanding?: (standing: Standing) => void;
	onScreen?: (screen: VncScreen | undefined) => void;
	/** Text to put on the display's clipboard, as copied from elsewhere. */
	clipboard?: string;
	onClipboard?: (text: string) => void;
}) {
	const screen = useRef<HTMLDivElement>(null);
	const connected = useRef<RFB | undefined>(undefined);
	const viewOnlyNow = useRef(viewOnly);
	const onStandingNow = useRef(onStanding);
	onStandingNow.current = onStanding;
	const onScreenNow = useRef(onScreen);
	onScreenNow.current = onScreen;
	const scaledNow = useRef(scaled);
	const onClipboardNow = useRef(onClipboard);
	onClipboardNow.current = onClipboard;
	/** What the display's clipboard holds, as far as this viewer knows. */
	const displayClipboard = useRef<string | undefined>(undefined);
	useEffect(() => {
		const viewer = connected.current;
		if (!viewer || clipboard === undefined || clipboard === displayClipboard.current) return;
		displayClipboard.current = clipboard;
		viewer.clipboardPasteFrom(clipboard);
	}, [clipboard]);
	// Taking over or handing back switches input on the open connection, without reconnecting.
	useEffect(() => {
		viewOnlyNow.current = viewOnly;
		if (!connected.current) return;
		connected.current.viewOnly = viewOnly;
	}, [viewOnly]);

	useEffect(() => {
		const element = screen.current;
		if (!element) return;
		let unmounted = false;
		onStandingNow.current?.("connecting");
		// Loaded only when somebody watches: noVNC is large, and most people never do.
		void import("@novnc/novnc").then(({ default: RFBClient }) => {
			if (unmounted) return;
			const opened = new RFBClient(element, url);
			connected.current = opened;
			opened.scaleViewport = scaledNow.current;
			opened.viewOnly = viewOnlyNow.current;
			opened.background = "var(--color-background)";
			opened.addEventListener("connect", () => {
				onStandingNow.current?.("connected");
				const canvas = element.querySelector("canvas");
				if (canvas) onScreenNow.current?.(screenOf(opened, canvas));
			});
			opened.addEventListener("clipboard", (event) => {
				const { text } = (event as CustomEvent<{ text: string }>).detail;
				displayClipboard.current = text;
				onClipboardNow.current?.(text);
			});
			opened.addEventListener("disconnect", () => {
				if (connected.current !== opened) return;
				onStandingNow.current?.("ended");
				onScreenNow.current?.(undefined);
			});
		});
		// Caught before noVNC's own handler, which sends every key on as it is.
		const shortcut = (event: KeyboardEvent) => {
			const viewer = connected.current;
			if (!viewer || viewOnlyNow.current) return;
			const key = event.key.toLowerCase();
			const command = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey;
			if (!command || event.altKey || !CTRL_SHORTCUTS.has(key)) return;
			if (!IS_MAC && key !== "v") return;
			event.preventDefault();
			event.stopPropagation();
			const pressCtrl = () => {
				// noVNC has already sent ⌘ down, which would make it ⌘ Ctrl to the app.
				if (IS_MAC) {
					viewer.sendKey(XK_SUPER_L, "MetaLeft", false);
					viewer.sendKey(XK_SUPER_R, "MetaRight", false);
				}
				viewer.sendKey(XK_CONTROL_L, "ControlLeft", true);
				viewer.sendKey(key.charCodeAt(0), `Key${key.toUpperCase()}`);
				viewer.sendKey(XK_CONTROL_L, "ControlLeft", false);
			};
			if (key !== "v") return pressCtrl();
			// The display asks for the text when its app pastes, after this has put it there.
			void navigator.clipboard
				.readText()
				.then((text) => {
					if (text === displayClipboard.current) return;
					displayClipboard.current = text;
					viewer.clipboardPasteFrom(text);
					onClipboardNow.current?.(text);
				})
				.catch(() => {})
				.finally(pressCtrl);
		};
		element.addEventListener("keydown", shortcut, { capture: true });
		return () => {
			unmounted = true;
			element.removeEventListener("keydown", shortcut, { capture: true });
			const viewer = connected.current;
			connected.current = undefined;
			viewer?.disconnect();
		};
	}, [url]);

	return <div ref={screen} className="absolute inset-0" />;
}

/** A display as noVNC draws it: its canvas, and the areas of it each update draws. */
export interface VncScreen {
	canvas: HTMLCanvasElement;
	/** Calls `listener` with each area of the canvas drawn, in pixels, until the returned function is called. */
	onDraw: (listener: (area: DrawnArea) => void) => () => void;
}

export interface DrawnArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * What `viewer` draws into `canvas`. noVNC says nothing when it draws, so
 * this wraps its display's `flip`, which copies each update's damaged area
 * to the canvas. That is noVNC's private API, as of 1.7: check it when
 * upgrading noVNC.
 */
function screenOf(viewer: RFB, canvas: HTMLCanvasElement): VncScreen {
	const display = (viewer as unknown as { _display: NoVncDisplay })._display;
	const listeners = new Set<(area: DrawnArea) => void>();
	const flip = display.flip.bind(display);
	display.flip = (fromQueue) => {
		// A flip asked for while updates are queued is queued itself, and drawn later.
		const drawsNow = display._renderQ.length === 0 || fromQueue;
		const { left, top, right, bottom } = display._damageBounds;
		flip(fromQueue);
		if (!drawsNow || right <= left || bottom <= top) return;
		const area = { x: left, y: top, width: right - left, height: bottom - top };
		for (const listener of listeners) listener(area);
	};
	return {
		canvas,
		onDraw: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

interface NoVncDisplay {
	flip: (fromQueue?: boolean) => void;
	_renderQ: unknown[];
	_damageBounds: { left: number; top: number; right: number; bottom: number };
}

/** Whether the person is on a Mac, where ⌘ does what Ctrl does elsewhere. */
export const IS_MAC =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The keyboard shortcuts with Ctrl that a Mac person presses with ⌘. */
const CTRL_SHORTCUTS = new Set(["c", "x", "v", "a", "z", "y"]);
/** X's keysyms for Ctrl and for ⌘, as noVNC sends it. Letters are their own lowercase character codes. */
const XK_CONTROL_L = 0xffe3;
const XK_SUPER_L = 0xffeb;
const XK_SUPER_R = 0xffec;

/** What a viewer that isn't showing anything says instead, with a way back from idle. */
export function StandingOverlay({
	standing,
	what,
	onReconnect,
}: {
	standing: Standing;
	what: "desktop" | "browser" | "window";
	onReconnect: () => void;
}) {
	if (standing === "connected") return null;
	const text = {
		connecting: what === "window" ? "Opening the window…" : `Starting the ${what}…`,
		ended: `The ${what} couldn't be reached. Close it and open it again to retry.`,
		idle: `Disconnected after ${IDLE_TIMEOUT_MINUTES} minutes unused, so the sandbox can pause.`,
	}[standing];
	return (
		<div className="absolute inset-0 grid place-items-center content-center gap-3 px-6 text-center text-muted-foreground text-sm">
			<p>{text}</p>
			{standing === "idle" && (
				<Button variant="outline" onClick={onReconnect}>
					Reconnect
				</Button>
			)}
		</div>
	);
}

/** The API's WebSocket for the display of one of the agent's desktop's windows. */
export function windowUrl(threadId: string, agentId: string, window: string) {
	return webSocketUrl(`/threads/${threadId}/agents/${agentId}/windows/${window}`);
}

/** The API's WebSocket for one of what the agent's desktop's server serves. */
export function desktopServerUrl(
	threadId: string,
	agentId: string,
	channel: "terminal" | "files" | "windows",
) {
	return webSocketUrl(`/threads/${threadId}/agents/${agentId}/desktop/${channel}`);
}

function webSocketUrl(path: string) {
	const url = new URL(`${apiBaseUrl}${path}`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}
