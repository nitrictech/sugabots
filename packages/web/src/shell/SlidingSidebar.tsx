import { cn } from "cn";
import { PanelLeft } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { REDUCED_MOTION, useMediaQuery } from "@/lib/media.ts";
import type { SidebarHiding } from "@/lib/sidebar-hidden.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/** How the sidebar's room opens and closes, sliding the page beside it. */
const SLIDE = "width 280ms cubic-bezier(0.2, 0.6, 0.2, 1)";
/**
 * How the sidebar itself fades in and out. On the sidebar, not its room, so
 * it is never part see-through over a chat that paints across it, and so
 * keeping a peeking sidebar leaves it as it is.
 */
const FADE = "opacity 220ms ease";
/** How long the pointer may be off a peeking sidebar, crossing between it and the button, before it goes. */
const PEEK_LINGER_MS = 200;

/**
 * The sidebar, narrowing to nothing and fading as it is put away beside a
 * chat, and widening and fading in as it comes back, so the page beside it
 * slides rather than jumps. Above it, in the corner, the button that does it,
 * which stays where it is either way.
 *
 * Put away, it peeks: pointing at the button or the window's left edge
 * brings it over the chat, without moving the chat, until the pointer leaves
 * it. Clicking the button then keeps it, beside the chat again. A phone, without
 * the sidebar, has none of this.
 */
export function SlidingSidebar({
	hiding,
	children,
}: {
	hiding: SidebarHiding;
	children: ReactNode;
}) {
	const hidden = hiding.hidden && hiding.chatShowing;
	const inner = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState<number>();
	const still = useMediaQuery(REDUCED_MOTION);
	const peek = usePeek();
	const peeking = hidden && peek.shown;
	// Only while it opens or closes, so dragging its edge still follows the pointer.
	const [sliding, setSliding] = useState(false);
	const [lastHidden, setLastHidden] = useState(hidden);
	if (lastHidden !== hidden) {
		setLastHidden(hidden);
		setSliding(!still);
	}
	useLayoutEffect(() => {
		const element = inner.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setWidth(element.offsetWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return (
		<>
			{hidden && (
				<div
					aria-hidden
					onMouseEnter={peek.enter}
					onMouseLeave={peek.leave}
					className="absolute inset-y-0 left-0 z-20 w-2 max-md:hidden"
				/>
			)}
			{hiding.chatShowing && (
				// As tall as a page's header, bottom border and all, so it centres on the header's line;
				// 16px in, so its 30px centres over the 62px rail's faces.
				<div className="absolute top-0 left-4 z-40 flex h-14 items-center border-transparent border-b max-md:hidden">
					<IconButton
						label={hiding.hidden ? "Show sidebar" : "Hide sidebar"}
						variant="bar"
						onMouseEnter={peek.enter}
						onMouseLeave={peek.leave}
						onClick={() => {
							// Put away under the pointer, it stays away until the pointer comes back.
							peek.dismiss();
							hiding.toggle();
						}}
						className="text-muted-foreground hover:text-foreground"
					>
						<PanelLeft size={16} strokeWidth={1.75} />
					</IconButton>
				</div>
			)}
			<div
				inert={hidden && !peeking}
				onTransitionEnd={(event) => {
					if (event.target === event.currentTarget) setSliding(false);
				}}
				className="flex min-h-0 shrink-0 overflow-hidden max-md:contents"
				style={{
					width: hidden ? 0 : width,
					transition: sliding ? SLIDE : undefined,
				}}
			>
				{/*
				 * Peeking, and while it slides, it hangs over the chat from the window's
				 * edge, outside the box that is still finding its width, so it is never cut off.
				 */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: only keeps a peek the pointer started; the keyboard opens the sidebar with the button. */}
				<div
					ref={inner}
					onMouseEnter={hidden ? peek.enter : undefined}
					onMouseLeave={hidden ? peek.leave : undefined}
					className={cn(
						"flex min-h-0 shrink-0 max-md:contents",
						(hidden || sliding) && "absolute inset-y-0 left-0 z-30",
						hidden && "shadow-dialog",
					)}
					style={{
						opacity: hidden && !peeking ? 0 : 1,
						transition: still ? undefined : FADE,
					}}
				>
					{children}
				</div>
			</div>
		</>
	);
}

/**
 * Whether the put-away sidebar is peeking: from when the pointer reaches the
 * button or the edge, while it is on them or the sidebar, and a moment after
 * it leaves, so crossing the gap between them keeps it up.
 */
function usePeek() {
	const [shown, setShown] = useState(false);
	const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(leaving.current), []);
	return {
		shown,
		enter: () => {
			clearTimeout(leaving.current);
			setShown(true);
		},
		leave: () => {
			clearTimeout(leaving.current);
			leaving.current = setTimeout(() => setShown(false), PEEK_LINGER_MS);
		},
		dismiss: () => {
			clearTimeout(leaving.current);
			setShown(false);
		},
	};
}
