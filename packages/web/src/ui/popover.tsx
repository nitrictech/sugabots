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
	"origin-(--transform-origin) rounded-lg border border-border-strong bg-panel text-foreground shadow-popover outline-none motion-safe:transition motion-safe:duration-150 motion-safe:data-starting-style:scale-95 motion-safe:data-starting-style:opacity-0 motion-safe:data-ending-style:scale-95 motion-safe:data-ending-style:opacity-0";

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
				<PopoverPrimitive.Popup
					className={
						typeof className === "function"
							? (state) => cn(POPOVER_SURFACE, className(state))
							: cn(POPOVER_SURFACE, className)
					}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}
