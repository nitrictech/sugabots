import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "cn";
import type { Ref, UIEventHandler } from "react";

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
	viewportRef?: Ref<HTMLDivElement>;
	onViewportScroll?: UIEventHandler<HTMLDivElement>;
};

/**
 * A scrolling region with a thin overlay scrollbar, so the sidebar and the
 * panels do not gain and lose a gutter as their content changes.
 */
export function ScrollArea({
	className,
	children,
	viewportRef,
	onViewportScroll,
	...props
}: ScrollAreaProps) {
	return (
		<ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
			<ScrollAreaPrimitive.Viewport
				ref={viewportRef}
				onScroll={onViewportScroll}
				className="focus-ring size-full"
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<Scrollbar />
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

function Scrollbar({
	orientation = "vertical",
	className,
	...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
	return (
		<ScrollAreaPrimitive.Scrollbar
			orientation={orientation}
			className={cn(
				"flex touch-none select-none p-px transition-colors",
				orientation === "vertical" ? "h-full w-2" : "h-2 flex-col",
				className,
			)}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong" />
		</ScrollAreaPrimitive.Scrollbar>
	);
}
