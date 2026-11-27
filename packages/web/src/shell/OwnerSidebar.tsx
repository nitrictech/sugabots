import { useRender } from "@base-ui/react/use-render";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, SquarePen } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useComputerAccess } from "@/lib/computer-providers.ts";
import { type OwnerPageName, ownerPages, useOwnerProblems } from "@/lib/owner-pages.ts";
import { ownerLink, ownerName, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { OwnerWork, useOwnerWork } from "@/shell/OwnerWork.tsx";
import { ProblemMark } from "@/ui/attention-dot.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SearchField } from "@/ui/search-field.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";

/** Which of a bot's or project's own pages is open, if one is. */
export type OwnerSidebarPage = OwnerPageName | undefined;

/**
 * The sidebar on a bot's or a project's pages, beside the rail: the way back to
 * everything, its own pages, a search over its work, then
 * `OwnerWork`. The rail names which bot or project it is. A bot's chats are
 * those of its default project.
 */
export function OwnerSidebar({
	owner,
	selectedChatId,
	page,
}: {
	owner: ResourceOwner;
	/** The chat open, marked in the list. */
	selectedChatId: string | undefined;
	/** The owner's own page open, if one is: its files, automations, computer, connectors or settings. */
	page: OwnerSidebarPage;
}) {
	const work = useOwnerWork(owner);
	const problems = useOwnerProblems(owner, work.automationFailing);
	const computersOn = useComputerAccess().data?.enabled === true;
	const name = ownerName(owner);
	const [search, setSearch] = useState("");
	return (
		<>
			{/* As tall as a page's header, bottom border and all, so it sits on the header's line. */}
			<div className="flex h-14 shrink-0 flex-col justify-center border-transparent border-b px-3">
				<PageRow
					link={<Link to="/$workspace" from="/$workspace" />}
					selected={false}
					icon={<ChevronLeft aria-hidden size={15} strokeWidth={1.75} />}
					label="All projects and bots"
				/>
			</div>
			<div className="flex flex-col gap-0.5 px-3 pt-1 pb-2">
				<nav aria-label={`${name}'s pages`} className="flex flex-col gap-px pb-1">
					{ownerPages(owner, { computersOn }).map(({ to, label, icon: Icon }) => (
						<PageRow
							key={to.page}
							link={ownerLink(owner, to)}
							selected={to.page === page}
							problem={problems[to.page]}
							icon={<Icon aria-hidden size={15} strokeWidth={1.75} />}
							label={label}
						/>
					))}
				</nav>
				{/* Its pages above, its work below. */}
				<div aria-hidden className="mx-2 my-1.5 h-px bg-border" />
				<div className="flex items-center gap-1">
					<SearchField
						look="sidebar"
						label={`Search ${name}'s chats`}
						placeholder="Search"
						value={search}
						onChange={setSearch}
						className="flex-1"
					/>
					<IconButton label="New chat" variant="row" render={ownerLink(owner, { page: "newChat" })}>
						<SquarePen aria-hidden />
					</IconButton>
				</div>
			</div>
			<OwnerWork
				owner={owner}
				work={work}
				selectedChatId={selectedChatId}
				search={search}
				className="scrollbar-on-hover min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-3"
			/>
		</>
	);
}

/** One of the bot's or project's own pages: its icon and name, and a mark for something wrong that the page sets right. */
function PageRow({
	link,
	selected,
	icon,
	label,
	problem,
}: {
	link: useRender.RenderProp;
	selected: boolean;
	icon: ReactNode;
	label: string;
	problem?: string;
}) {
	return useRender({
		render: link,
		props: {
			"aria-current": selected ? "page" : undefined,
			// The problem describes the row rather than naming it, so the row keeps its page's name.
			"aria-description": problem,
			className: sidebarRow({ selected, radius: "md" }),
			children: (
				<>
					{icon}
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{problem && (
						<span aria-hidden className="flex">
							<ProblemMark label={problem} />
						</span>
					)}
				</>
			),
		},
	});
}
