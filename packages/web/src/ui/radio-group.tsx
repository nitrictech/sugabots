import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "cn";

/**
 * A pick-one row of short options side by side, such as Dark / Light / System.
 * Arrow keys move the choice and only the chosen option is in the tab order.
 * Name it with `aria-label`; give it a `value` none of its items has when none
 * of them describes the current state.
 */
function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
	return (
		<RadioGroupPrimitive
			data-slot="radio-group"
			className={cn("flex shrink-0 rounded-lg bg-chip p-0.5 data-disabled:opacity-50", className)}
			{...props}
		/>
	);
}

/** One option in a `RadioGroup`, labelled by its children. */
function RadioGroupItem<Value>({ className, ...props }: RadioPrimitive.Root.Props<Value>) {
	return (
		<RadioPrimitive.Root
			data-slot="radio-group-item"
			className={cn(
				"focus-ring cursor-pointer rounded-md px-3 py-1 font-medium text-muted-foreground text-xs transition-colors data-checked:bg-member-avatar data-disabled:cursor-default data-checked:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export { RadioGroup, RadioGroupItem };
