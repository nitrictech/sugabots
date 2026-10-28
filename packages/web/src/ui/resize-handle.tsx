import { cn } from "cn";
import { type KeyboardEvent, type PointerEvent, type RefObject, useState } from "react";

/** How far an arrow key moves the handle, in pixels. */
const KEY_STEP_PX = 24;

/**
 * The edge of a pane that drags to resize it, or moves with the arrow keys
 * once focused. It sits over the pane's `edge`, which must be positioned, and
 * reports the width the pane would have, never under `min`. The pane caps its
 * own width, so a width past the room left is shown as wide as fits.
 */
export function ResizeHandle({
	label,
	pane,
	edge,
	min,
	onResize,
}: {
	label: string;
	/** The pane it resizes, measured as a drag starts. */
	pane: RefObject<HTMLElement | null>;
	/** Which side of the pane it is on: dragging away from the pane widens it. */
	edge: "start" | "end";
	min: number;
	onResize: (width: number) => void;
}) {
	const [dragging, setDragging] = useState(false);
	// Dragging toward the start widens a pane whose handle is on its start edge.
	const sign = edge === "start" ? -1 : 1;
	const widthNow = () => pane.current?.getBoundingClientRect().width ?? min;

	function startDrag(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		const startX = event.clientX;
		const startWidth = widthNow();
		setDragging(true);
		const move = (moved: globalThis.PointerEvent) =>
			onResize(Math.max(min, startWidth + sign * (moved.clientX - startX)));
		const stop = () => {
			setDragging(false);
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", stop);
			handle.removeEventListener("pointercancel", stop);
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", stop);
		handle.addEventListener("pointercancel", stop);
	}

	function nudge(event: KeyboardEvent<HTMLDivElement>) {
		const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		if (step === 0) return;
		event.preventDefault();
		onResize(Math.max(min, widthNow() + sign * step * KEY_STEP_PX));
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: an `<hr>` cannot be focused or dragged.
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuenow={Math.round(widthNow())}
			aria-valuemin={min}
			tabIndex={0}
			onPointerDown={startDrag}
			onKeyDown={nudge}
			className={cn(
				"group/resize absolute inset-y-0 z-10 flex w-2 cursor-col-resize touch-none justify-center outline-none max-md:hidden",
				edge === "start" ? "-left-1" : "-right-1",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"h-full w-px transition-colors group-hover/resize:bg-border-dashed group-focus-visible/resize:bg-ring",
					dragging && "bg-border-dashed",
				)}
			/>
		</div>
	);
}
