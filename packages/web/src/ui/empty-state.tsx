import { cn } from "cn";
import type { ReactNode } from "react";

/*
 * Nothing here yet, and what to do about it: a flat statement of what is
 * missing, and one line naming what would fill it. The second part is the one
 * that matters. "No bots yet" is a dead end; naming the button that makes one
 * tells somebody where to go next.
 */
export function EmptyState({
	title,
	icon,
	children,
	className,
}: {
	title: ReactNode;
	/** A mark of what would be here, on a tile above the title. */
	icon?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid flex-1 place-items-center p-6", className)}>
			<div className="flex max-w-[400px] flex-col items-center gap-2.5 text-center">
				{icon && (
					<span
						aria-hidden
						className="mb-3.5 grid size-14 place-items-center rounded-xl border border-border bg-list text-muted-foreground [&_svg]:size-5"
					>
						{icon}
					</span>
				)}
				<div className="font-semibold text-foreground text-xl">{title}</div>
				{children !== undefined && (
					<div className="text-md text-muted-foreground leading-relaxed">{children}</div>
				)}
			</div>
		</div>
	);
}
