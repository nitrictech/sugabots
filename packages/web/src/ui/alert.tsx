import { cn } from "cn";
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
