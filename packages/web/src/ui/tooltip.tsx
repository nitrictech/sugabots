import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/**
 * A label for a control that has only an icon. One provider wraps the app, so
 * hovering from one icon button to the next does not restart the delay.
 */

export function TooltipProvider({ delay = 400, ...props }: TooltipPrimitive.Provider.Props) {
	return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

export function Tooltip({
	children,
	label,
	side = "bottom",
	...props
}: TooltipPrimitive.Root.Props & {
	label: ReactNode;
	side?: "top" | "bottom";
	/** The control the tooltip describes. It is the trigger, so it must be one element. */
	children: ReactElement;
}) {
	return (
		<TooltipPrimitive.Root {...props}>
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner side={side} sideOffset={6} className="isolate z-50">
					<TooltipPrimitive.Popup className="rounded-md bg-heading px-2 py-1 font-sans text-xs text-background shadow-sm">
						{label}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
