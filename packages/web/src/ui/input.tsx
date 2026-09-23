import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * A single-line field. The focus treatment is the design's: the accent as a
 * one-pixel border with a wide, very pale ring behind it, rather than a
 * heavyweight outline.
 */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
	return (
		<input
			type={type}
			className={cn(
				"focus-ring h-9 w-full rounded-lg border border-input bg-raised px-2.5 text-base text-foreground transition-shadow",
				"placeholder:text-subtle-foreground focus-visible:border-primary-tint-border",
				"aria-invalid:border-destructive disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}
