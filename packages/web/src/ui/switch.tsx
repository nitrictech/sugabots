import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

/**
 * An on/off switch. Name it with `aria-label` when no visible label is tied to it.
 * A disabled switch receives no pointer events, so a tooltip saying why it is
 * disabled hangs on an element around it.
 */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			nativeButton
			render={<button type="button" />}
			className={cn(
				"focus-ring group/switch relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-border-strong p-0.5 transition-colors duration-150 data-checked:bg-switch-on data-disabled:cursor-default data-disabled:opacity-45",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-4 rounded-full bg-switch-thumb transition-transform duration-150 data-checked:translate-x-4 data-checked:bg-primary-foreground"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
