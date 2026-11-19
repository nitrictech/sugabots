import { useRender } from "@base-ui/react/use-render";
import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft, ListFilter, Lock, SquarePen } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useModels } from "@/lib/bots.ts";
import { useComputerAccess } from "@/lib/computer-providers.ts";
import { ownerPages, ownerProblems } from "@/lib/owner-pages.ts";
import {
	OwnerLink,
	ownerLink,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	useLeadBot,
} from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { OwnerWork, SHOWING_LABELS, type Showing, useOwnerWork } from "@/shell/OwnerWork.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { ProblemMark } from "@/ui/attention-dot.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SearchField } from "@/ui/search-field.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";
import { Tooltip } from "@/ui/tooltip.tsx";

/** Which of a bot's or project's own pages is open, if one is. */
export type OwnerSidebarPage = "files" | "automations" | undefined;

/**
 * The sidebar on a bot's or a project's pages, beside the rail: its name, the
 * way back to everything, its own pages, a search and a filter over its work,
 * then `OwnerWork`. A project also shows its lead bot's face. A bot's threads
 * are those of its default project.
 */
export function OwnerSidebar({
	owner,
	selectedConversationId,
	page,
}: {
	owner: ResourceOwner;
	/** The thread open, marked in the list. */
	selectedConversationId: string | undefined;
	/** The owner's files or automations, while one of them is the page open. */
	page: OwnerSidebarPage;
}) {
	const lead = useLeadBot(owner);
	const enabledModels = useModels().data?.models;
	const automationFailed = useOwnerWork(owner).latestRunFailed;
	const problems = ownerProblems(owner, { lead, enabledModels, automationFailed });
	const computersOn = useComputerAccess().data?.enabled === true;
	const name = ownerName(owner);
	const [search, setSearch] = useState("");
	const [showing, setShowing] = useState<Showing>("all");
	return (
		<>
			<div className="flex flex-col gap-0.5 px-3 pt-1 pb-2">
				<OwnerHeading owner={owner} lead={lead} />
				<nav aria-label={`${name}'s pages`} className="flex flex-col gap-px pb-1">
					<PageRow
						link={<Link to="/$workspace" from="/$workspace" />}
						selected={false}
						icon={<ChevronLeft aria-hidden size={15} strokeWidth={1.75} />}
						label="All projects and bots"
					/>
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
				<div className="flex items-center gap-1 pt-1">
					<SearchField
						look="sidebar"
						label={`Search ${name}'s threads`}
						placeholder="Search threads"
						value={search}
						onChange={setSearch}
						className="flex-1"
					/>
					<ShowingMenu showing={showing} onChange={setShowing} />
					<IconButton
						label="New thread"
						variant="row"
						render={ownerLink(owner, { page: "newThread" })}
					>
						<SquarePen aria-hidden />
					</IconButton>
				</div>
			</div>
			<OwnerWork
				owner={owner}
				selectedConversationId={selectedConversationId}
				search={search}
				showing={showing}
				className="scrollbar-on-hover min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-3"
			/>
		</>
	);
}

/**
 * At the head of the sidebar, on one line: the bot's face and name, or the
 * project's mark and name with its lead bot's face at the end, which opens the
 * project's settings for whoever may open them. A project with no lead bot
 * shows no face; its Settings row carries that problem instead.
 */
function OwnerHeading({ owner, lead }: { owner: ResourceOwner; lead: Bot | undefined }) {
	if ("bot" in owner) {
		const { bot } = owner;
		return (
			<h2 className="m-0 flex h-9 min-w-0 items-center gap-2.5 px-2 font-semibold text-foreground text-sm">
				<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={20} />
				<span className="min-w-0 truncate">{bot.name}</span>
			</h2>
		);
	}
	const { project } = owner;
	const leadFace = lead && (
		<BotAvatar color={lead.color} face={lead.face} shape={lead.shape} size={18} />
	);
	return (
		<div className="flex h-9 min-w-0 items-center gap-2.5 px-2">
			<h2 className="m-0 flex min-w-0 flex-1 items-center gap-2.5 font-semibold text-foreground text-sm">
				<ProjectInitial project={project} />
				<span className="min-w-0 truncate">{project.name}</span>
				{project.visibility === "private" && (
					<Lock
						aria-label="Private"
						size={11}
						strokeWidth={2.25}
						className="shrink-0 text-subtle-foreground"
					/>
				)}
			</h2>
			{lead && (
				<Tooltip label={`Led by ${lead.name}`}>
					{resourcePermissions(owner).openSettings ? (
						<OwnerLink
							owner={owner}
							to={{ page: "settings" }}
							aria-label={`Led by ${lead.name}`}
							className="focus-ring flex shrink-0 rounded-full"
						>
							{leadFace}
						</OwnerLink>
					) : (
						<span role="img" aria-label={`Led by ${lead.name}`} className="flex shrink-0">
							{leadFace}
						</span>
					)}
				</Tooltip>
			)}
		</div>
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

/** Lists all the work, the threads alone, or the automations' runs alone. */
function ShowingMenu({
	showing,
	onChange,
}: {
	showing: Showing;
	onChange: (showing: Showing) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<IconButton
						label={`Showing ${SHOWING_LABELS[showing].toLocaleLowerCase()}`}
						variant="row"
						className={cn(showing !== "all" && "bg-row-selected text-foreground")}
					>
						<ListFilter aria-hidden />
					</IconButton>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuRadioGroup
					value={showing}
					onValueChange={(value) => onChange(value as Showing)}
				>
					{(Object.keys(SHOWING_LABELS) as Showing[]).map((option) => (
						<DropdownMenuRadioItem key={option} value={option}>
							{SHOWING_LABELS[option]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
