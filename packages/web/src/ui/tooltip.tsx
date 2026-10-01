import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/**
 * A label for a control that has only an icon. One provider wraps the app, so
 * hovering from one icon button to the next does not restart the delay.
 */

export function TooltipProvider({ delay = 400, ...props }: TooltipPrimitive.Provider.Props) {
	return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

type TooltipProps = TooltipPrimitive.Root.Props & {
	side?: "top" | "bottom" | "right";
	/** Which edge of the trigger the tooltip lines up with, along `side`. */
	align?: "start" | "center" | "end";
	/** The control the tooltip describes. It is the trigger, so it must be one element. */
	children: ReactElement;
};

export function Tooltip({ label, ...props }: TooltipProps & { label: ReactNode }) {
	return (
		<FloatingTooltip
			{...props}
			content={label}
			popupClassName="max-w-60 text-balance rounded-md bg-foreground px-2 py-1 font-sans text-xs text-background shadow-sm"
		/>
	);
}

/**
 * A card that names what a control does now and says how to change it, such
 * as the composer's people-only toggle. For a plain name, use {@link Tooltip}.
 */
export function DetailTooltip({
	title,
	description,
	...props
}: TooltipProps & { title: ReactNode; description: ReactNode }) {
	return (
		<FloatingTooltip
			{...props}
			content={
				<>
					<span className="font-semibold text-[13px] text-foreground">{title}</span>
					<span className="text-muted-foreground text-xs">{description}</span>
				</>
			}
			popupClassName="flex max-w-64 flex-col gap-0.5 rounded-lg bg-chip px-3 py-2 font-sans shadow-md ring-1 ring-border"
		/>
	);
}

function FloatingTooltip({
	children,
	content,
	popupClassName,
	side = "bottom",
	align = "center",
	...props
}: TooltipProps & { content: ReactNode; popupClassName: string }) {
	return (
		<TooltipPrimitive.Root {...props}>
			<TooltipPrimitive.Trigger render={children} />
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner
					side={side}
					align={align}
					sideOffset={6}
					className="isolate z-50"
				>
					<TooltipPrimitive.Popup className={popupClassName}>{content}</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
