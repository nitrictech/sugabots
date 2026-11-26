import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * A key, or keys pressed together, named beside what they do, such as Esc
 * beside a button that exits, or Ctrl+C beside a menu's Copy.
 */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
	return (
		<kbd
			className={cn(
				"rounded-xs border border-border-dashed px-1.5 py-0.5 font-sans text-3xs text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}
