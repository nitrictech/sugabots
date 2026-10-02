import { cn } from "cn";
import { CircleCheck } from "lucide-react";
import type { ComponentProps } from "react";

/*
 * Something went wrong, said once, where it went wrong.
 *
 * `role="alert"` is part of the component rather than left to each caller,
 * because a failure a sighted user can see and a screen reader cannot announce
 * is the failure mode this is here to prevent.
 */
export function Alert({ className, ...props }: ComponentProps<"p">) {
	return <p role="alert" className={cn("text-md text-destructive-text", className)} {...props} />;
}

/** Something worked, said where it was tried, and announced to screen readers. */
export function Success({ className, children, ...props }: ComponentProps<"p">) {
	return (
		<p
			role="status"
			className={cn("flex items-center gap-1.5 font-medium text-md text-success-text", className)}
			{...props}
		>
			<CircleCheck aria-hidden size={16} className="shrink-0" />
			{children}
		</p>
	);
}
