import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "cn";

/**
 * A scrolling region with a thin overlay scrollbar, so the sidebar and the
 * panels do not gain and lose a gutter as their content changes.
 */
export function ScrollArea({ className, children, ...props }: ScrollAreaPrimitive.Root.Props) {
	return (
		<ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
			<ScrollAreaPrimitive.Viewport className="focus-ring size-full">
				{children}
			</ScrollAreaPrimitive.Viewport>
			<Scrollbar />
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

/** The vertical scrollbar, the only one a `ScrollArea` has. */
function Scrollbar() {
	return (
		<ScrollAreaPrimitive.Scrollbar
			orientation="vertical"
			className="flex h-full w-2 touch-none select-none p-px transition-colors"
		>
			<ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong" />
		</ScrollAreaPrimitive.Scrollbar>
	);
}
