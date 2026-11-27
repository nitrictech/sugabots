import { cva } from "class-variance-authority";
import { cn } from "cn";

const chip = cva("rounded-full border-2 text-sm font-semibold transition-colors", {
	variants: {
		tone: {
			neutral: "px-3 py-0.5",
			// A size up, for the one choice a demo is about.
			brand: "px-3.5 py-1",
		},
		picked: { true: "", false: "border-input text-muted-foreground hover:text-foreground" },
	},
	compoundVariants: [
		{ tone: "neutral", picked: true, className: "border-foreground bg-foreground text-background" },
		{ tone: "brand", picked: true, className: "border-brand bg-brand text-brand-foreground" },
	],
});

interface ChoiceChipsProps<T extends string> {
	/** The group's legend. */
	label: string;
	/**
	 * How the legend shows: above the chips by default, `sr-only` to screen
	 * readers only, or `float-left` as the first item in the chips' row (a
	 * floated legend is laid out as one of the fieldset's flex items).
	 */
	labelClassName?: string;
	/** Each choice's value and its text, in order. */
	options: Record<T, string>;
	value: T;
	onChange: (value: T) => void;
	tone?: "neutral" | "brand";
	className?: string;
}

/** A row of pressed-or-not chips choosing one of a few options, as the docs' demos offer them. */
export function ChoiceChips<T extends string>({
	label,
	labelClassName,
	options,
	value,
	onChange,
	tone = "neutral",
	className,
}: ChoiceChipsProps<T>) {
	return (
		<fieldset className={cn("flex flex-wrap items-center gap-2", className)}>
			<legend className={labelClassName}>{label}</legend>
			{(Object.keys(options) as T[]).map((option) => (
				<button
					key={option}
					type="button"
					aria-pressed={option === value}
					onClick={() => onChange(option)}
					className={chip({ tone, picked: option === value })}
				>
					{options[option]}
				</button>
			))}
		</fieldset>
	);
}
