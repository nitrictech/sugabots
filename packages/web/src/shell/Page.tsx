import type { Pod } from "@sugabots/contracts";
import { cn } from "cn";
import type { ReactNode } from "react";
import { formatAge } from "@/lib/list-time.ts";
import { HeaderBack } from "@/screens/ChatHeader.tsx";

/**
 * Where a page sits on a phone: one of its tabs, titled large with no Back,
 * or a page in a pod, such as its Artifacts, which covers the pod's Home and
 * leads back to it.
 */
export type PagePlace = { kind: "tab" } | { kind: "pod"; pod: Pod };

/**
 * A page beside the sidebar, such as Inbox: its `PageHeader`, and what it
 * holds scrolling under it.
 */
export function Page({
	title,
	place,
	actions,
	className,
	children,
}: {
	title: string;
	place: PagePlace;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={title} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
			<PageHeader title={title} place={place} actions={actions} />
			<div className="tab-bar-clearance min-h-0 flex-1 overflow-y-auto">{children}</div>
		</section>
	);
}

/**
 * The title across the top of a page or of a list beside the sidebar, with
 * `actions` at the right: the same in each, so the titles line up. On a
 * phone, a tab's page is titled large, as the tabs' are, and a pod's page
 * has Back to the pod's Home.
 */
export function PageHeader({
	title,
	place,
	actions,
}: {
	title: string;
	place: PagePlace;
	actions?: ReactNode;
}) {
	const tab = place.kind === "tab";
	return (
		<header
			className={cn(
				"flex h-[52px] shrink-0 items-center gap-3 border-border border-b pr-4 pl-6",
				"max-md:h-auto max-md:border-b-0 max-md:pt-[max(12px,env(safe-area-inset-top))] max-md:pb-2",
				tab ? "max-md:gap-0.5 max-md:pr-2 max-md:pl-4" : "max-md:gap-2 max-md:px-4",
			)}
		>
			{place.kind === "pod" && <HeaderBack back={{ to: "pod", pod: place.pod }} />}
			<h1
				className={cn(
					"m-0 min-w-0 flex-1 truncate font-medium text-[14px] text-foreground",
					tab
						? "max-md:font-semibold max-md:text-[28px] max-md:tracking-[-0.02em]"
						: // Centred between Back and the actions, as a phone's own titles are.
							"max-md:text-center max-md:font-semibold max-md:text-[17px]",
				)}
			>
				{title}
			</h1>
			{actions}
			{/* With no action, room as wide as one, so the title stays centred. */}
			{!tab && !actions && <span aria-hidden className="size-11 shrink-0 md:hidden" />}
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
