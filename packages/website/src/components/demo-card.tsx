import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * The raised, rounded panel a docs demo plays out in. It takes a div's props
 * so `motion.create` can animate it.
 */
export function DemoCard({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"my-8 flex flex-col overflow-hidden rounded-3xl bg-card text-sm text-card-foreground shadow-xl ring-1 ring-foreground/10",
				className,
			)}
			{...props}
		/>
	);
}
