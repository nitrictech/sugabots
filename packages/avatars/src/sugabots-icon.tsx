import { cn } from "cn";
import type { ComponentProps } from "react";
import { sugabotsLogo } from "./sugabots-logo.ts";

/** Lucide's grid, which the icon is drawn on so it sits among Lucide's icons. */
const ICON_SIZE = 24;
/** How far in from the grid's edge the dots start, as Lucide insets a filled icon. */
const DOTS_INSET = 4;
/** The dots drawn a little smaller than the logo's, so they stay apart at line size. */
const DOT_SHRINK = 0.85;

const { dots } = sugabotsLogo;
const dotsStart = Math.min(...dots.map((dot) => dot.cx - dot.r));
const dotsEnd = Math.max(...dots.map((dot) => dot.cx + dot.r));
const scale = (ICON_SIZE - DOTS_INSET * 2) / (dotsEnd - dotsStart);

/**
 * The Sugabots mark as an icon, in one colour: its four dots, without the tile
 * around them, which at line size reads as a button. Drawn on Lucide's grid in
 * `currentColor`, so it stands among Lucide's icons. Hidden from screen
 * readers, as `SugabotsMark` is; size it with `className`.
 */
export function SugabotsIcon({ className, ...props }: ComponentProps<"svg">) {
	return (
		<svg
			viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}
			fill="currentColor"
			aria-hidden
			className={cn("shrink-0", className)}
			{...props}
		>
			{dots.map((dot) => (
				<circle
					key={`${dot.cx},${dot.cy}`}
					cx={DOTS_INSET + (dot.cx - dotsStart) * scale}
					cy={DOTS_INSET + (dot.cy - dotsStart) * scale}
					r={dot.r * scale * DOT_SHRINK}
				/>
			))}
		</svg>
	);
}
