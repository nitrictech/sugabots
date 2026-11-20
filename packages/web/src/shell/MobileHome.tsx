import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot, Hash, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useAssistant, useBots } from "@/lib/bots.ts";
import { useProjectMarkers } from "@/lib/chats.ts";
import { useComputerAccess } from "@/lib/computer-providers.ts";
import { botLink, botsLink, projectLink, projectsLink } from "@/lib/links.ts";
import { ownerPages } from "@/lib/owner-pages.ts";
import { useProjects } from "@/lib/projects.ts";
import { OwnerLink, ownerLink, ownerName, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { OwnerWork, useOwnerWork } from "@/shell/OwnerWork.tsx";
import { sidebarBots } from "@/shell/Sidebar.tsx";
import { SidebarBot } from "@/shell/SidebarBot.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";

/** A row of Home on a phone, sized for a thumb. */
const HOME_ROW = sidebarRow({ phone: true });

/** A page of Home on a phone, under its title, with `action` beside it. */
function MobilePage({
	title,
	action,
	className,
	children,
}: {
	title: string;
	action?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className={cn(
				"@container/sidebar flex min-h-0 min-w-0 flex-1 flex-col bg-list pt-safe-or-3",
				className,
			)}
		>
			<header className="flex items-center gap-2 pt-4.5 pr-3 pb-3 pl-4.5">
				<h1 className="m-0 min-w-0 flex-1 truncate font-semibold text-xl text-foreground tracking-tight">
					{title}
				</h1>
				{action}
			</header>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2 pb-4 pl-1.5">
				{children}
			</div>
		</section>
	);
}

/**
 * Home on a phone: the Personal Assistant, the projects the person is in and
 * the bots they pinned, each opening its threads.
 */
export function MobileHome({ className }: { className?: string }) {
	const { data: projects } = useProjects();
	const { bots } = useBots();
	const assistant = useAssistant();
	const { markerOf } = useProjectMarkers();
	const pinned = sidebarBots(bots ?? []);
	return (
		<MobilePage title="Home" className={className}>
			{assistant && (
				<Link {...botLink(assistant)} className={HOME_ROW}>
					<BotAvatar
						color={assistant.color}
						face={assistant.face}
						shape={assistant.shape}
						size={22}
					/>
					<span className="min-w-0 flex-1 truncate">{assistant.name}</span>
				</Link>
			)}
			<HomeSection label="Projects">
				{projects
					?.filter((project) => project.isMember)
					.map((project) => (
						<Link key={project.id} {...projectLink(project)} className={HOME_ROW}>
							<ProjectInitial project={project} />
							<span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
						</Link>
					))}
				<Link {...projectsLink()} className={HOME_ROW}>
					<Hash aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
					Browse projects
				</Link>
			</HomeSection>
			<HomeSection label="Bots">
				<ul className="m-0 flex list-none flex-col gap-px p-0">
					{pinned.map((bot) => (
						<SidebarBot
							key={bot.id}
							standing={{ bot, ...markerOf(bot.defaultProjectId) }}
							selected={false}
						/>
					))}
				</ul>
				<Link {...botsLink()} className={HOME_ROW}>
					<Bot aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
					Browse bots
				</Link>
			</HomeSection>
		</MobilePage>
	);
}

/**
 * A bot or a project on a phone, its sidebar as a page: its work, as the
 * sidebar beside it lists it on a wider screen, then its own pages, and + to
 * start a thread.
 */
export function MobileOwner({ owner }: { owner: ResourceOwner }) {
	const work = useOwnerWork(owner);
	const computersOn = useComputerAccess().data?.enabled === true;
	const name = ownerName(owner);
	return (
		<MobilePage
			title={name}
			action={
				<IconButton
					label={"bot" in owner ? `New thread with ${name}` : `New thread in ${name}`}
					render={ownerLink(owner, { page: "newThread" })}
				>
					<Plus strokeWidth={2.2} />
				</IconButton>
			}
		>
			<OwnerWork owner={owner} work={work} selectedConversationId={undefined} />
			<HomeSection label="Pages">
				{ownerPages(owner, { computersOn }).map(({ to, label, icon: Icon }) => (
					<OwnerLink
						key={to.page}
						owner={owner}
						to={to}
						className={cn(HOME_ROW, "[&>svg]:size-4.5 [&>svg]:shrink-0")}
					>
						<Icon />
						{label}
					</OwnerLink>
				))}
			</HomeSection>
		</MobilePage>
	);
}

function HomeSection({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section aria-label={label} className="flex flex-col gap-px">
			<h2 className="m-0 px-3 pb-1 font-medium text-subtle-foreground text-xs">{label}</h2>
			{children}
		</section>
	);
}
