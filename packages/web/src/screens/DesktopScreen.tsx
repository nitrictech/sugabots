import { useEffect, useRef, useState } from "react";
import { type DrawnArea, type Standing, type VncScreen, VncView } from "./VncView.tsx";

/** Where a window is on the desktop's display, and how big, in pixels. */
export interface ScreenBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The desktop's display over VNC, drawn nowhere itself: unscaled and unseen
 * under the desktop. `ScreenRegion`s show its windows, each wherever its
 * frame is, and send it what the person does in them. Whatever reaches the
 * display goes to the point under the pointer of the window shown there, or
 * to an empty corner of the display over anything else, such as a title
 * strip, so a drag goes from window to window as the person sees them,
 * wherever they are on the display. Gives `onScreen` what it draws once
 * connected.
 */
export function SharedScreen({
	url,
	viewOnly,
	onStanding,
	onScreen,
	onClipboard,
}: {
	url: string;
	viewOnly: boolean;
	onStanding: (standing: Standing) => void;
	onScreen: (screen: VncScreen | undefined) => void;
	onClipboard: (text: string) => void;
}) {
	const [screen, setScreen] = useState<VncScreen | undefined>(undefined);
	useEffect(() => {
		onScreen(screen);
		if (!screen) return;
		return sendToWindowsUnderPointer(screen.canvas);
	}, [screen, onScreen]);
	return (
		// noVNC centres a canvas smaller than its room; this keeps it at the desktop's corner.
		<div
			aria-hidden
			className="pointer-events-none absolute inset-0 overflow-hidden opacity-0 [&_canvas]:m-0!"
		>
			<VncView
				url={url}
				viewOnly={viewOnly}
				scaled={false}
				onStanding={onStanding}
				onScreen={setScreen}
				onClipboard={onClipboard}
			/>
		</div>
	);
}

const POINTER_EVENTS = ["mousedown", "mouseup", "mousemove", "wheel", "contextmenu"] as const;
/** Marks a window's region with where its window is on the display. */
const SCREEN_X = "data-screen-x";
const SCREEN_Y = "data-screen-y";

/**
 * Makes noVNC, drawing into `canvas`, send the display each pointer event
 * at the point it lands on in the window under the pointer. noVNC reads the
 * point from the event, against its canvas, including from the page-wide
 * layer it catches a drag on, so each event is stopped before it does and
 * sent again with the point on the display. Returns how to stop.
 */
function sendToWindowsUnderPointer(canvas: HTMLCanvasElement) {
	const translated = new WeakSet<Event>();
	const translate = (event: MouseEvent) => {
		if (translated.has(event)) return;
		event.stopImmediatePropagation();
		event.preventDefault();
		// An empty corner, past every window and its room on the display.
		const point = displayPointAt(event.clientX, event.clientY) ?? {
			x: canvas.width - 1,
			y: canvas.height - 1,
		};
		const origin = canvas.getBoundingClientRect();
		const copy = eventAt(event, origin.left + point.x, origin.top + point.y);
		translated.add(copy);
		canvas.dispatchEvent(copy);
	};
	for (const type of POINTER_EVENTS) canvas.addEventListener(type, translate, { capture: true });
	return () => {
		for (const type of POINTER_EVENTS) {
			canvas.removeEventListener(type, translate, { capture: true });
		}
	};
}

/** Where on the display the point on the page at `clientX`, `clientY` is, if a window's region is on top there. */
function displayPointAt(clientX: number, clientY: number) {
	for (const element of document.elementsFromPoint(clientX, clientY)) {
		// noVNC's page-wide layer for catching a drag.
		if (element.id === "noVNC_mouse_capture_elem") continue;
		const region = element.closest<HTMLElement>(`[${SCREEN_X}]`);
		if (!region) return undefined;
		const shown = region.getBoundingClientRect();
		return {
			x: Number(region.getAttribute(SCREEN_X)) + Math.round(clientX - shown.left),
			y: Number(region.getAttribute(SCREEN_Y)) + Math.round(clientY - shown.top),
		};
	}
	return undefined;
}

/** `event` again, at `clientX`, `clientY` on the page. */
function eventAt(event: MouseEvent, clientX: number, clientY: number) {
	const init: MouseEventInit = {
		bubbles: event.bubbles,
		cancelable: true,
		clientX,
		clientY,
		screenX: event.screenX,
		screenY: event.screenY,
		button: event.button,
		buttons: event.buttons,
		detail: event.detail,
		altKey: event.altKey,
		ctrlKey: event.ctrlKey,
		metaKey: event.metaKey,
		shiftKey: event.shiftKey,
	};
	if (!(event instanceof WheelEvent)) return new MouseEvent(event.type, init);
	return new WheelEvent(event.type, {
		...init,
		deltaX: event.deltaX,
		deltaY: event.deltaY,
		deltaZ: event.deltaZ,
		deltaMode: event.deltaMode,
	});
}

/**
 * The part of the desktop's display at `bounds`, drawn from its top left at
 * the size it is there, unstretched, and drawn again as that part changes.
 * Moved or resized, a window shows where it was until the display has drawn
 * it where it is, so it never shows what was behind it. Unless `viewOnly`,
 * the person's mouse goes to the same point in the window on the display,
 * and their keys with it. The person's pointer takes the shape the
 * display's has, such as a text cursor over text.
 */
export function ScreenRegion({
	screen,
	bounds,
	viewOnly,
}: {
	screen: VncScreen | undefined;
	bounds: ScreenBounds;
	viewOnly: boolean;
}) {
	const room = useRef<HTMLDivElement>(null);
	const region = useRef<HTMLCanvasElement>(null);
	const shown = useRef<ScreenBounds>(bounds);
	const awaited = useRef<ScreenBounds | undefined>(undefined);
	const recentDraws = useRef<{ area: DrawnArea; at: number }[]>([]);
	const redraw = useRef<() => void>(() => {});

	useEffect(() => {
		const canvas = region.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context || !screen) return;
		let frame: number | undefined;
		const draw = () => {
			frame = undefined;
			const { x, y, width, height } = shown.current;
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
				canvas.style.width = `${width}px`;
				canvas.style.height = `${height}px`;
			}
			context.drawImage(screen.canvas, x, y, width, height, 0, 0, width, height);
		};
		redraw.current = () => {
			frame ??= requestAnimationFrame(draw);
		};
		redraw.current();
		const stopListening = screen.onDraw((area) => {
			const now = performance.now();
			recentDraws.current = [
				...recentDraws.current.filter(({ at }) => now - at < RECENT_DRAW_MS),
				{ area, at: now },
			];
			const awaiting = awaited.current;
			if (awaiting && overlaps(area, awaiting)) {
				shown.current = awaiting;
				awaited.current = undefined;
			} else if (!overlaps(area, shown.current)) {
				return;
			}
			redraw.current();
		});
		return () => {
			stopListening();
			if (frame !== undefined) cancelAnimationFrame(frame);
		};
	}, [screen]);

	const { x, y, width, height } = bounds;
	useEffect(() => {
		const next = { x, y, width, height };
		if (sameBounds(next, shown.current)) {
			awaited.current = undefined;
			return;
		}
		// The display may have drawn the window where it is before saying it's there.
		const now = performance.now();
		const drawnThere = recentDraws.current.some(
			({ area, at }) => now - at < RECENT_DRAW_MS && overlaps(area, next),
		);
		if (drawnThere) {
			shown.current = next;
			awaited.current = undefined;
			redraw.current();
			return;
		}
		awaited.current = next;
		const giveUp = setTimeout(() => {
			if (awaited.current !== next) return;
			shown.current = next;
			awaited.current = undefined;
			redraw.current();
		}, PIXELS_WAIT_MS);
		return () => clearTimeout(giveUp);
	}, [x, y, width, height]);

	useEffect(() => {
		const element = room.current;
		if (!element || !screen) return;
		return screen.onCursor((cursor) => {
			element.style.cursor = cursor;
		});
	}, [screen]);

	useEffect(() => {
		const element = room.current;
		if (!element || !screen || viewOnly) return;
		// To noVNC, which sends it on to the window under the pointer.
		const forward = (event: MouseEvent) => {
			event.preventDefault();
			screen.canvas.dispatchEvent(eventAt(event, event.clientX, event.clientY));
		};
		for (const type of POINTER_EVENTS) {
			element.addEventListener(type, forward, { passive: false });
		}
		return () => {
			for (const type of POINTER_EVENTS) element.removeEventListener(type, forward);
		};
	}, [screen, viewOnly]);

	return (
		<div
			ref={room}
			className="absolute inset-0 overflow-hidden"
			{...{ [SCREEN_X]: bounds.x, [SCREEN_Y]: bounds.y }}
		>
			<canvas ref={region} className="absolute top-0 left-0" />
		</div>
	);
}

/** How long a drawn area counts as just drawn, when a window's new place on the display comes in after its pixels. */
const RECENT_DRAW_MS = 400;
/** How long a moved window waits for the display to draw it before showing its new place anyway, as one with nothing new to draw might. */
const PIXELS_WAIT_MS = 300;

function overlaps(a: DrawnArea, b: ScreenBounds) {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function sameBounds(a: ScreenBounds, b: ScreenBounds) {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
