import { cn } from "cn";
import type { ComponentProps } from "react";
import { LOGO_SIZE, sugabotsLogo } from "./sugabots-logo.ts";

/** Lucide's grid, which the icon is drawn on so it sits among Lucide's icons. */
const ICON_SIZE = 24;
/** Where the tile's outline runs, as Lucide insets a square icon's outline. */
const TILE_INSET = 3;
const scale = (ICON_SIZE - TILE_INSET * 2) / LOGO_SIZE;
/** The dots drawn a little smaller than the logo's, to keep clear of the outline its stroke adds. */
const DOT_SHRINK = 0.8;

/**
 * The Sugabots mark as a line icon, in one colour: the tile's outline with its
 * four dots, drawn as Lucide draws its icons (a 24-unit grid, `currentColor`,
 * rounded strokes, `strokeWidth` as given), so it can stand among them. Hidden
 * from screen readers, as `SugabotsMark` is; size it with `className`.
 */
export function SugabotsIcon({ className, strokeWidth = 2, ...props }: ComponentProps<"svg">) {
	const { tile, dots } = sugabotsLogo;
	return (
		<svg
			viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
			className={cn("shrink-0", className)}
			{...props}
		>
			<rect
				x={TILE_INSET}
				y={TILE_INSET}
				width={ICON_SIZE - TILE_INSET * 2}
				height={ICON_SIZE - TILE_INSET * 2}
				rx={tile.radius * scale}
			/>
			{dots.map((dot) => (
				<circle
					key={`${dot.cx},${dot.cy}`}
					cx={TILE_INSET + dot.cx * scale}
					cy={TILE_INSET + dot.cy * scale}
					r={dot.r * scale * DOT_SHRINK}
					fill="currentColor"
					stroke="none"
				/>
			))}
		</svg>
	);
}
