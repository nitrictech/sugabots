import { Meter as MeterPrimitive } from "@base-ui/react/meter";
import { cn } from "cn";

/**
 * How much of something is used, such as a disk, as a thin bar. Unlike
 * `Progress` it measures a level, not a task that finishes. Name it with
 * `aria-label`. Its children are marks drawn on the bar, placed absolutely.
 */
function Meter({
	className,
	indicatorClassName,
	children,
	...props
}: MeterPrimitive.Root.Props & { indicatorClassName?: string }) {
	return (
		<MeterPrimitive.Root data-slot="meter" className={className} {...props}>
			<MeterPrimitive.Track
				data-slot="meter-track"
				className="relative block h-1 w-full rounded-full bg-chip-strong"
			>
				<MeterPrimitive.Indicator
					data-slot="meter-indicator"
					className={cn("block h-full rounded-full bg-meter transition-all", indicatorClassName)}
				/>
				{children}
			</MeterPrimitive.Track>
		</MeterPrimitive.Root>
	);
}

export { Meter };
