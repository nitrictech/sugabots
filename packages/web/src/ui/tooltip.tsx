import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/**
 * A label for a control that has only an icon. One provider wraps the app, so
 * hovering from one icon button to the next does not restart the delay.
 */

export function TooltipProvider({ delay = 400, ...props }: TooltipPrimitive.Provider.Props) {
	return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

type TooltipProps = TooltipPrimitive.Root.Props &
	Pick<TooltipPrimitive.Trigger.Props, "delay" | "closeOnClick"> & {
		side?: "top" | "bottom" | "right";
		/** Which edge of the trigger the tooltip lines up with, along `side`. */
		align?: "start" | "center" | "end";
		/** The control the tooltip describes. It is the trigger, so it must be one element. */
		children: ReactElement;
	};

export function Tooltip({
	children,
	label,
	side = "bottom",
	align = "center",
	delay,
	closeOnClick,
	...props
}: TooltipProps & { label: ReactNode }) {
	return (
		<TooltipPrimitive.Root {...props}>
			<TooltipPrimitive.Trigger render={children} delay={delay} closeOnClick={closeOnClick} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner
					side={side}
					align={align}
					sideOffset={6}
					className="isolate z-50"
				>
					<TooltipPrimitive.Popup className="max-w-60 text-balance rounded-md bg-foreground px-2 py-1 font-sans text-xs text-background shadow-sm">
						{label}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
