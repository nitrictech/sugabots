import { cn } from "cn";
import type { ReactNode } from "react";

/*
 * Nothing here yet, and what to do about it.
 *
 * The design gives every empty state the same three parts — a dashed mark, a
 * flat statement of what is missing, and one line naming the thing that would
 * fill it. The third part is the one that matters: "no threads yet" is a dead
 * end, whereas naming the system agent that opens one, or the composer below, tells
 * somebody where to go next.
 */
export function EmptyState({
	title,
	children,
	className,
}: {
	title: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("grid flex-1 place-items-center p-6", className)}>
			<div className="flex max-w-[400px] flex-col items-center gap-2.5 text-center">
				<div className="font-semibold text-heading text-xl">{title}</div>
				{children !== undefined && (
					<div className="text-md text-muted-foreground leading-relaxed">{children}</div>
				)}
			</div>
		</div>
	);
}
