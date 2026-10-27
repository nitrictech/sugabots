import { useEffect, useRef } from "react";
import { type DrawnArea, type Standing, type VncScreen, VncView } from "./VncView.tsx";

/** Where a window is on the desktop's display, and how big, in pixels: the same as on the desktop drawn here. */
export interface ScreenBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The desktop's display over VNC, drawn nowhere itself: laid over the
 * desktop at its own size, unscaled and unseen, so a point on the desktop is
 * the same point on the display. `ScreenRegion`s show its windows, each
 * where its frame is, and send it what the person does in them. Gives
 * `onScreen` what it draws once connected.
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
				onScreen={onScreen}
				onClipboard={onClipboard}
			/>
		</div>
	);
}

/**
 * The part of the desktop's display at `bounds`, drawn from its top left at
 * the size it is there, unstretched, and drawn again as that part changes.
 * Moved or resized, a window shows where it was until the display has drawn
 * it where it is, so it never shows what was behind it. Unless `viewOnly`,
 * the person's mouse goes to the display at the same point on the desktop,
 * and their keys with it, so a drag that starts here and ends over another
 * window ends there on the display too.
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
		if (!element || !screen || viewOnly) return;
		// noVNC reads where the pointer is from the event, against its own canvas,
		// which lies over the desktop at the display's size.
		const forward = (event: MouseEvent) => {
			event.preventDefault();
			const copy =
				event instanceof WheelEvent
					? new WheelEvent(event.type, event)
					: new MouseEvent(event.type, event);
			screen.canvas.dispatchEvent(copy);
		};
		const types = ["mousedown", "mouseup", "mousemove", "wheel", "contextmenu"] as const;
		for (const type of types) element.addEventListener(type, forward, { passive: false });
		return () => {
			for (const type of types) element.removeEventListener(type, forward);
		};
	}, [screen, viewOnly]);

	return (
		<div ref={room} className="absolute inset-0 overflow-hidden">
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
