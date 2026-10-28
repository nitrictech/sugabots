import { cn } from "cn";
import type { ReactNode } from "react";
import { formatAge } from "@/lib/list-time.ts";

/**
 * A page beside the sidebar, such as Inbox: its `PageHeader`, and what it
 * holds scrolling under it.
 */
export function Page({
	title,
	actions,
	back,
	className,
	children,
}: PageHeaderProps & {
	className?: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
			<PageHeader title={title} actions={actions} back={back} />
			<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
		</section>
	);
}

interface PageHeaderProps {
	title: string;
	/** Buttons at the right of the title, each an `IconButton` with `variant="bar"`. */
	actions?: ReactNode;
	/**
	 * Where a phone's Back leads, as an `IconButton` with `variant="glass"`, on
	 * a page reached from another. A tab's page, such as Inbox, has none.
	 */
	back?: ReactNode;
}

/**
 * The title across the top of a page or of a list beside the sidebar, with
 * `actions` at the right: the same in each, so the titles line up. A phone
 * gives a tab's page a large title, and a page reached from another its
 * `back` with the title centred beside it.
 */
export function PageHeader({ title, actions, back }: PageHeaderProps) {
	return (
		<header
			className={cn(
				"flex h-[52px] shrink-0 items-center gap-3 border-border border-b pr-4 pl-6",
				"max-md:h-auto max-md:border-b-0 max-md:pt-[calc(env(safe-area-inset-top)+16px)] max-md:pb-2 max-md:pl-4",
				actions ? "max-md:pr-2" : "max-md:pr-4",
			)}
		>
			{back && <span className="flex md:hidden">{back}</span>}
			<h1
				className={cn(
					"m-0 min-w-0 flex-1 truncate font-medium text-[14px] text-foreground",
					back
						? "max-md:text-center max-md:font-semibold max-md:text-[17px]"
						: "max-md:font-semibold max-md:text-[28px] max-md:tracking-[-0.02em]",
				)}
			>
				{title}
			</h1>
			{/* A phone's buttons are as large as a fingertip; a tablet's sit in the header's gap. */}
			<div className="flex items-center gap-0.5 max-md:*:size-10 md:contents">{actions}</div>
			{back && !actions && <span aria-hidden className="w-9 shrink-0 md:hidden" />}
		</header>
	);
}

/** When a row's item happened, at its right. */
export function ListTime({ at, className }: { at: string; className?: string }) {
	return (
		<time dateTime={at} className={cn("shrink-0 text-subtle-foreground text-xs", className)}>
			{formatAge(new Date(at), new Date())}
		</time>
	);
}
