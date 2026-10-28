import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { formatAge } from "@/lib/list-time.ts";

/**
 * A page beside the sidebar, such as Inbox: its `PageHeader`, and what it
 * holds scrolling under it.
 */
export function Page({
	title,
	actions,
	className,
	children,
}: {
	title: string;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
			<PageHeader title={title} actions={actions} />
			<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
		</section>
	);
}

/**
 * The title across the top of a page or of a list beside the sidebar, with
 * `actions` at the right: the same in each, so the titles line up. On a
 * phone, where it covers the sidebar, Back leads to it.
 */
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
	return (
		<header className="flex h-[52px] shrink-0 items-center gap-3 border-border border-b pr-4 pl-6 max-md:pl-2">
			<Link
				from="/$workspace"
				to="./agents"
				aria-label="Back"
				className="focus-ring grid size-9 shrink-0 place-items-center rounded-full text-link md:hidden"
			>
				<ChevronLeft aria-hidden size={24} strokeWidth={2.2} />
			</Link>
			<h1 className="m-0 min-w-0 flex-1 truncate font-medium text-[14px] text-foreground">
				{title}
			</h1>
			{actions}
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
