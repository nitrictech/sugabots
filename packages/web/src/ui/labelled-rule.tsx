import { cn } from "cn";

/**
 * A hairline across a list with words in its middle, marking where one stretch
 * of it ends and the next begins, such as a new day. `className` sets its
 * padding.
 */
export function LabelledRule({ children, className }: { children: string; className?: string }) {
	return (
		<div className={cn("flex items-center gap-3 px-5", className)}>
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="whitespace-nowrap text-subtle-foreground text-xs">{children}</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</div>
	);
}
