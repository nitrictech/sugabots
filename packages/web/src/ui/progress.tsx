import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "cn";

/** How far a task such as an upload has got, as a thin bar. Name it with `aria-label`. */
function Progress({
	className,
	trackClassName,
	indicatorClassName,
	children,
	...props
}: ProgressPrimitive.Root.Props & { trackClassName?: string; indicatorClassName?: string }) {
	return (
		<ProgressPrimitive.Root data-slot="progress" className={className} {...props}>
			{children}
			<ProgressPrimitive.Track
				data-slot="progress-track"
				className={cn(
					"block h-1 w-full overflow-hidden rounded-full bg-chip-strong",
					trackClassName,
				)}
			>
				<ProgressPrimitive.Indicator
					data-slot="progress-indicator"
					className={cn("block h-full bg-meter transition-all", indicatorClassName)}
				/>
			</ProgressPrimitive.Track>
		</ProgressPrimitive.Root>
	);
}

export { Progress };
