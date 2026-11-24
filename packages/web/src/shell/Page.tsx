import { cn } from "cn";
import type { ReactNode } from "react";
import { formatAge } from "@/lib/list-time.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { useSidebarHiddenBesideChat } from "@/lib/sidebar-hidden.tsx";
import { backToOwner, HeaderBack } from "@/screens/ChatHeader.tsx";
import { CrumbSeparator } from "@/shell/BotCrumb.tsx";

/**
 * Where a page sits on a phone: one of its tabs, titled large with no Back,
 * or a page of a project's or a bot's, such as its Files, which leads back
 * to the project or the bot, or, `under` its Settings as a project's Members
 * is, back to its Settings.
 */
type PagePlace = { kind: "tab" } | { kind: "owner"; owner: ResourceOwner; under?: "settings" };

/**
 * A page beside the sidebar, such as Approvals: its `PageHeader`, and what it
 * holds scrolling under it.
 */
export function Page({
	title,
	label = title,
	parent,
	place,
	actions,
	children,
}: {
	title: string;
	/**
	 * Its name for a screen reader, when its title alone is another landmark's
	 * too, as a project's Bots is the icon rail's: "Revenue's bots".
	 */
	label?: string;
	/** What the page belongs to, before its title in the breadcrumb, such as its bot. */
	parent?: ReactNode;
	place: PagePlace;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<PageHeader title={title} parent={parent} place={place} actions={actions} />
			<div className="tab-bar-clearance min-h-0 flex-1 overflow-y-auto">{children}</div>
		</section>
	);
}

/**
 * The title across the top of a page or of a list beside the sidebar, with
 * `actions` at the right: the same in each, so the titles line up. On a
 * phone, a tab's page is titled large, as the tabs' are, and a project's or
 * bot's page has Back to it. From a tablet up, `parent` goes before the title
 * as a breadcrumb, and the header clears the button that brings the sidebar
 * back while the sidebar is put away.
 */
export function PageHeader({
	title,
	parent,
	place,
	actions,
}: {
	title: string;
	/** What the page belongs to, before its title as a breadcrumb: "Growth Desk / Files". */
	parent?: ReactNode;
	place: PagePlace;
	actions?: ReactNode;
}) {
	const tab = place.kind === "tab";
	const sidebarHidden = useSidebarHiddenBesideChat();
	return (
		<header
			className={cn(
				"flex h-13 shrink-0 items-center gap-3 border-border border-b pr-4 transition-all duration-300 ease-out",
				sidebarHidden ? "md:pl-14" : "pl-6",
				"max-md:h-auto max-md:border-b-0 max-md:pt-safe-or-3 max-md:pb-2",
				tab ? "max-md:gap-0.5 max-md:pr-2 max-md:pl-4" : "max-md:gap-2 max-md:px-4",
			)}
		>
			{place.kind === "owner" && (
				<HeaderBack
					back={
						place.under === "settings"
							? { to: "ownerSettings", owner: place.owner }
							: backToOwner(place.owner)
					}
				/>
			)}
			{parent && (
				<span className="flex min-w-0 shrink items-center gap-1.5 max-md:hidden">
					{parent}
					<CrumbSeparator />
				</span>
			)}
			<h1
				className={cn(
					"m-0 min-w-0 flex-1 truncate font-medium text-sm text-foreground",
					tab
						? "max-md:font-semibold max-md:text-3xl max-md:tracking-tight"
						: // Centred between Back and the actions, as a phone's own titles are.
							"max-md:text-center max-md:font-semibold max-md:text-base",
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
