import { useEffect, useRef } from "react";
import { type Standing, VncView } from "./VncView.tsx";

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
 * `onScreen` the canvas it draws into once connected.
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
	onScreen: (screen: HTMLCanvasElement | undefined) => void;
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
 * The part of the desktop's display at `bounds`, filling its parent, kept
 * current as the display changes. Unless `viewOnly`, the person's mouse goes
 * to the display at the same point on the desktop, and their keys with it,
 * so a drag that starts here and ends over another window ends there on the
 * display too.
 */
export function ScreenRegion({
	screen,
	bounds,
	viewOnly,
}: {
	screen: HTMLCanvasElement | undefined;
	bounds: ScreenBounds;
	viewOnly: boolean;
}) {
	const region = useRef<HTMLCanvasElement>(null);
	const boundsNow = useRef(bounds);
	boundsNow.current = bounds;

	useEffect(() => {
		const canvas = region.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context || !screen) return;
		let frame = requestAnimationFrame(function copy() {
			const { x, y, width, height } = boundsNow.current;
			if (canvas.width !== width) canvas.width = width;
			if (canvas.height !== height) canvas.height = height;
			context.drawImage(screen, x, y, width, height, 0, 0, width, height);
			frame = requestAnimationFrame(copy);
		});
		return () => cancelAnimationFrame(frame);
	}, [screen]);

	useEffect(() => {
		const canvas = region.current;
		if (!canvas || !screen || viewOnly) return;
		// noVNC reads where the pointer is from the event, against its own canvas,
		// which lies over the desktop at the display's size.
		const forward = (event: MouseEvent) => {
			event.preventDefault();
			const copy =
				event instanceof WheelEvent
					? new WheelEvent(event.type, event)
					: new MouseEvent(event.type, event);
			screen.dispatchEvent(copy);
		};
		const types = ["mousedown", "mouseup", "mousemove", "wheel", "contextmenu"] as const;
		for (const type of types) canvas.addEventListener(type, forward, { passive: false });
		return () => {
			for (const type of types) canvas.removeEventListener(type, forward);
		};
	}, [screen, viewOnly]);

	return <canvas ref={region} className="absolute inset-0 size-full" />;
}
