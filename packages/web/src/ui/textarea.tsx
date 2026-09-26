import { cn } from "cn";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"focus-ring flex field-sizing-content min-h-16 w-full rounded-2xl border border-transparent bg-list px-4 py-3 text-[15px] text-foreground leading-normal transition-shadow placeholder:text-subtle-foreground focus-visible:border-primary-tint-border disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
