import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";

/*
 * A card that floats beside what opened it, drawn as the design draws every
 * popover: a raised panel edged in a strong hairline with a soft shadow, kept
 * clear of the window's edges. Open it with Base UI's `Popover.Root` and
 * `Popover.Trigger`, and put this inside the root.
 */

/** The panel every popover is drawn as, for one that has to be another element. */
export const POPOVER_SURFACE =
	"origin-(--transform-origin) rounded-lg border border-border-strong bg-panel text-foreground shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95";

export function PopoverContent({
	side = "bottom",
	align = "start",
	anchor,
	className,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<PopoverPrimitive.Positioner.Props, "side" | "align" | "anchor">) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				side={side}
				align={align}
				anchor={anchor}
				sideOffset={6}
				collisionPadding={16}
				className="isolate z-50 outline-none"
			>
				<PopoverPrimitive.Popup className={cn(POPOVER_SURFACE, className)} {...props} />
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}
