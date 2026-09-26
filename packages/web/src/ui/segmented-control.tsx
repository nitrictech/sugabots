import { cn } from "cn";
import { useId } from "react";

/**
 * A pick-one row of short options, such as Dark / Light / System. Each option
 * is a native radio button, so arrow keys move the choice and only the chosen
 * one is in the tab order.
 */
export function SegmentedControl<Value extends string>({
	label,
	options,
	value,
	onChange,
	className,
}: {
	/** Names the group for assistive technology. */
	label: string;
	options: readonly { value: Value; label: string }[];
	/** Undefined when none of the options describes the current state, so none is shown chosen. */
	value: Value | undefined;
	onChange: (value: Value) => void;
	className?: string;
}) {
	const name = useId();

	return (
		<fieldset className={cn("m-0 flex shrink-0 rounded-[10px] border-0 bg-chip p-0.5", className)}>
			<legend className="sr-only">{label}</legend>
			{options.map((option) => (
				<label
					key={option.value}
					className={cn(
						"cursor-pointer rounded-[8px] px-[11px] py-[5px] font-medium text-sm transition-colors has-checked:bg-person-avatar has-checked:text-foreground",
						"text-muted-foreground has-focus-visible:shadow-(--ring-shadow)",
					)}
				>
					<input
						type="radio"
						name={name}
						value={option.value}
						checked={option.value === value}
						onChange={() => onChange(option.value)}
						className="sr-only"
					/>
					{option.label}
				</label>
			))}
		</fieldset>
	);
}
