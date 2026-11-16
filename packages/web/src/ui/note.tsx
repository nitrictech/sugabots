import { Info } from "@nitric/suga-icons";
import { cn } from "cn";
import type { ComponentProps } from "react";

/** Something worth knowing before going on, set apart from the settings around it. */
export function Note({ className, children, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex items-start gap-3 rounded-panel bg-list px-4 py-3 text-sm text-soft-foreground leading-normal",
				className,
			)}
			{...props}
		>
			<Info aria-hidden className="mt-0.5 shrink-0 text-subtle-foreground" />
			<p className="m-0">{children}</p>
		</div>
	);
}
