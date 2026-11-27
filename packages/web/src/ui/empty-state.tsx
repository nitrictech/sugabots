import { cn } from "cn";
import type { ReactNode } from "react";

/*
 * Nothing here yet, and what to do about it: a flat statement of what is
 * missing, and one line naming what would fill it. The second part is the one
 * that matters. "No bots yet" is a dead end; naming the button that makes one
 * tells somebody where to go next. `actions`, under it, are the ways to go,
 * such as the button that makes one, each on a line of its own.
 */
export function EmptyState({
	title,
	icon,
	page,
	compact = false,
	children,
	actions,
}: {
	title: ReactNode;
	/**
	 * Standing in for a whole page: `min`, such as one whose address names
	 * nothing, is held at least 320px tall; `fill` is as tall as the page leaves
	 * above the tabs, so there is nothing to scroll.
	 */
	page?: "min" | "fill";
	/** In a small surface such as a sheet: no padding of its own, and its actions as wide as it is. */
	compact?: boolean;
	/** A mark of what would be here, on a tile above the title. */
	icon?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"grid place-items-center",
				compact ? "pt-2" : page === "fill" ? "h-above-tab-bar px-6 pt-6 pb-24" : "flex-1 p-6",
				page === "min" && "min-h-80",
			)}
		>
			<div
				className={cn(
					"flex max-w-96 flex-col items-center gap-2.5 text-center",
					compact && "w-full",
				)}
			>
				{icon && (
					<span
						aria-hidden
						className="mb-3.5 grid size-14 place-items-center rounded-xl border border-border bg-list text-muted-foreground [&_svg]:size-5"
					>
						{icon}
					</span>
				)}
				<div className="font-semibold text-foreground text-base">{title}</div>
				{children !== undefined && (
					<div className="text-xs text-muted-foreground leading-relaxed">{children}</div>
				)}
				{actions && (
					<div
						className={cn(
							"flex flex-col gap-3 pt-0.5 text-xs text-muted-foreground leading-relaxed",
							compact ? "mt-3 items-stretch self-stretch" : "items-center",
						)}
					>
						{actions}
					</div>
				)}
			</div>
		</div>
	);
}
