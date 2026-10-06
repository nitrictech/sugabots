import { cn } from "cn";
import type { ComponentProps } from "react";
import { LOGO_SIZE, sugabotsLogo } from "./sugabots-logo.ts";

/**
 * The Sugabots mark, hidden from screen readers, so show the name beside it.
 * It is drawn inline rather than as an `<img alt="">`, which search engines
 * report as an image missing its alt text. It has no intrinsic size, so size
 * it with `className` (e.g. `size-8`).
 */
export function SugabotsMark({ className, ...props }: ComponentProps<"svg">) {
	const { tile, dots } = sugabotsLogo;
	return (
		<svg
			viewBox={`0 0 ${LOGO_SIZE} ${LOGO_SIZE}`}
			aria-hidden
			className={cn("shrink-0", className)}
			{...props}
		>
			<rect width={LOGO_SIZE} height={LOGO_SIZE} rx={tile.radius} fill={tile.fill} />
			{dots.map((dot) => (
				<circle key={`${dot.cx},${dot.cy}`} {...dot} />
			))}
		</svg>
	);
}
