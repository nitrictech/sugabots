import { cn } from "cn";
import type { ReactNode, PointerEvent as ReactPointerEvent, RefObject } from "react";

/** Where a window is on the desktop, in pixels from its top left, and how it's shown. */
export interface Placement {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Higher is in front. */
	order: number;
	minimized: boolean;
	/** Filling the desktop, whatever its own size. */
	maximized: boolean;
}

/** How the desktop places a window and hears what is done to it, whatever the window shows. */
export interface WindowFrame {
	placement: Placement;
	front: boolean;
	ringColor: string | undefined;
	surface: RefObject<HTMLDivElement | null>;
	onFocus: () => void;
	onPlace: (change: Partial<Placement>) => void;
	onMinimize: () => void;
	onClose?: () => void;
}

export const MIN_WINDOW_WIDTH = 320;
export const MIN_WINDOW_HEIGHT = 200;
const TITLE_STRIP_HEIGHT = 36;
/** How much of a window stays on the desktop when it's dragged off an edge, in pixels. */
const KEPT_VISIBLE = 80;

/**
 * A window on the desktop: a title strip to drag it by, with traffic lights
 * to close it (given `onClose`), tuck it into the dock and fill the desktop,
 * and a corner to resize it by. `title` sits in the middle of the strip: the
 * window's name, or the browser's address bar. The window in front is ringed
 * in `ringColor`, the colour of whoever is driving the desktop, if anyone.
 * Clicking anywhere in it brings it to the front.
 */
export function DesktopWindow({
	label,
	title,
	placement,
	front,
	ringColor,
	surface,
	onFocus,
	onPlace,
	onMinimize,
	onClose,
	children,
}: WindowFrame & {
	/** Names the window for assistive technology. */
	label: string;
	title: ReactNode;
	children: ReactNode;
}) {
	/** Follows the pointer from where it went down until it comes up, with `change` saying how the window moves. */
	const track =
		(change: (dx: number, dy: number, from: Placement) => Partial<Placement>) =>
		(event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0 || placement.maximized || isControl(event.target)) return;
			event.preventDefault();
			const handle = event.currentTarget;
			handle.setPointerCapture(event.pointerId);
			const from = placement;
			const start = { x: event.clientX, y: event.clientY };
			const bounds = surface.current?.getBoundingClientRect();
			const move = (moved: PointerEvent) => {
				const next = change(moved.clientX - start.x, moved.clientY - start.y, from);
				onPlace(bounds ? keptInside(next, from, bounds) : next);
			};
			const up = () => {
				handle.removeEventListener("pointermove", move);
				handle.removeEventListener("pointerup", up);
			};
			handle.addEventListener("pointermove", move);
			handle.addEventListener("pointerup", up);
		};

	return (
		<section
			aria-label={label}
			onPointerDownCapture={onFocus}
			className={cn(
				"absolute flex flex-col overflow-hidden bg-panel",
				placement.maximized ? "rounded-none" : "rounded-[12px]",
				front ? "shadow-2xl" : "border border-border-strong shadow-lg",
			)}
			style={{
				...(placement.maximized
					? { inset: 0 }
					: {
							left: placement.x,
							top: placement.y,
							width: placement.width,
							height: placement.height,
						}),
				zIndex: placement.order,
				...(front && {
					outline: `2px solid ${ringColor ?? "var(--border-strong)"}`,
					outlineOffset: -1,
				}),
			}}
		>
			<header
				onPointerDown={track((dx, dy, from) => ({ x: from.x + dx, y: from.y + dy }))}
				className={cn(
					"grid shrink-0 touch-none select-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-border border-b bg-aside px-3",
					!placement.maximized && "cursor-grab active:cursor-grabbing",
				)}
				style={{ height: TITLE_STRIP_HEIGHT }}
			>
				<TrafficLights
					lit={front}
					onClose={onClose}
					onMinimize={onMinimize}
					onMaximize={() => onPlace({ maximized: !placement.maximized })}
					maximized={placement.maximized}
				/>
				<div className="flex min-w-0 justify-center">{title}</div>
				{/* Balances the lights, so the title sits in the middle of the strip. */}
				<span aria-hidden className="w-[52px]" />
			</header>
			<div className="relative min-h-0 flex-1">{children}</div>
			{!placement.maximized && (
				<div
					aria-hidden
					onPointerDown={track((dx, dy, from) => ({
						width: Math.max(MIN_WINDOW_WIDTH, from.width + dx),
						height: Math.max(MIN_WINDOW_HEIGHT, from.height + dy),
					}))}
					className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
				/>
			)}
		</section>
	);
}

/** The window's name, in the middle of its title strip. */
export function WindowTitle({ children }: { children: ReactNode }) {
	return <h3 className="m-0 truncate font-medium text-[13px] text-muted-foreground">{children}</h3>;
}

const LIGHTS = {
	close: "#ff5f57",
	minimize: "#febc2e",
	maximize: "#28c840",
} as const;

/**
 * Close, tuck into the dock, and fill the desktop: lit on the window in
 * front, grey behind it. A window that can't be closed has its close light
 * greyed and out of reach.
 */
function TrafficLights({
	lit,
	maximized,
	onClose,
	onMinimize,
	onMaximize,
}: {
	lit: boolean;
	maximized: boolean;
	onClose?: () => void;
	onMinimize: () => void;
	onMaximize: () => void;
}) {
	const light = (label: string, color: string, onClick: (() => void) | undefined) => (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={!onClick}
			onClick={onClick}
			className="focus-ring size-3 rounded-full bg-tile transition-colors disabled:cursor-default"
			style={lit && onClick ? { backgroundColor: color } : undefined}
		/>
	);
	return (
		<div className="flex w-[52px] items-center gap-2">
			{light("Close", LIGHTS.close, onClose)}
			{light("Minimize", LIGHTS.minimize, onMinimize)}
			{light(maximized ? "Restore" : "Fill the desktop", LIGHTS.maximize, onMaximize)}
		</div>
	);
}

/** Whether a pointer went down on a control in the title strip, which drags nothing. */
function isControl(target: EventTarget) {
	return target instanceof Element && target.closest("button, input, a, [role='tab']") !== null;
}

/** `next`, moved so the window's title strip stays on the desktop. */
function keptInside(
	next: Partial<Placement>,
	from: Placement,
	bounds: DOMRect,
): Partial<Placement> {
	const width = next.width ?? from.width;
	const visible = Math.min(width, KEPT_VISIBLE);
	return {
		...next,
		...(next.x !== undefined && {
			x: Math.min(Math.max(next.x, visible - width), bounds.width - visible),
		}),
		...(next.y !== undefined && {
			y: Math.min(Math.max(next.y, 0), bounds.height - TITLE_STRIP_HEIGHT),
		}),
	};
}
