import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * The box a bot's or an automation's instructions are written in: a tall
 * textarea that grows by its corner, borderless on the card that holds it, and
 * named "Instructions" for a screen reader unless a visible label names it.
 * `className` sets its height, padding and text size where they differ.
 */
export function InstructionsField({
	className,
	"aria-label": ariaLabel = "Instructions",
	...props
}: ComponentProps<"textarea">) {
	return (
		<textarea
			aria-label={ariaLabel}
			className={cn(
				"block min-h-60 w-full resize-y rounded-xl bg-transparent p-3.5 text-xs text-foreground leading-relaxed outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)",
				className,
			)}
			{...props}
		/>
	);
}
