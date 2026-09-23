import { cn } from "cn";
import type { ComponentProps } from "react";

/*
 * A small piece of state beside a label: a `later` marker, an unread count, a
 * provider's `Connected` or `Missing key` pill.
 *
 * The design uses several of these and they are all the same object at
 * different intensities, so they are one component with variants rather than a
 * span with its own classes each time. The provider status pills in the model
 * settings (NIT-1764) are the next ones, and belong here when they arrive.
 */

export function Badge({
	variant = "outline",
	className,
	...props
}: ComponentProps<"span"> & {
	/**
	 * `outline` for a word beside a label, which should not outshout it.
	 * `filled` for a number somebody is meant to read at a glance, where an
	 * outline around one or two digits is thinner than the digits themselves.
	 */
	variant?: "outline" | "filled";
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-xs px-1 font-mono text-2xs uppercase tracking-wider",
				variant === "filled"
					? // Surface-relative, so the same badge is right in the rail, in a
						// panel and in a dialog without being told where it is.
						"bg-surface-accent px-1.5 font-semibold text-surface-muted-foreground"
					: "border border-input font-medium text-subtle-foreground",
				className,
			)}
			{...props}
		/>
	);
}
