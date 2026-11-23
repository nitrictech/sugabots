import type { Bot, Project } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { botLink, projectLink } from "@/lib/links.ts";
import { OwnerLink, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";

const CRUMB =
	"focus-ring flex min-w-0 shrink items-center gap-1.5 rounded-sm font-medium text-muted-foreground text-sm transition-colors hover:text-foreground";

/**
 * A bot at the head of a page's breadcrumb, as "Growth Desk / Files" has
 * it: its face and name, leading to its own page.
 */
export function BotCrumb({ bot }: { bot: Bot }) {
	return (
		<Link {...botLink(bot)} className={CRUMB}>
			<span aria-hidden className="flex shrink-0">
				<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={16} />
			</span>
			<span className="min-w-0 truncate">{bot.name}</span>
		</Link>
	);
}

/** A project at the head of a page's breadcrumb: its mark and name, leading to the project. */
export function ProjectCrumb({ project }: { project: Project }) {
	return (
		<Link {...projectLink(project)} className={CRUMB}>
			<ProjectInitial project={project} size="sm" />
			<span className="min-w-0 truncate">{project.name}</span>
		</Link>
	);
}

/** A bot or a project at the head of a page's breadcrumb. */
export function OwnerCrumb({ owner }: { owner: ResourceOwner }) {
	return "bot" in owner ? <BotCrumb bot={owner.bot} /> : <ProjectCrumb project={owner.project} />;
}

/** Between a breadcrumb's steps. */
export function CrumbSeparator() {
	return (
		<span aria-hidden className="shrink-0 text-subtle-foreground text-sm">
			/
		</span>
	);
}

/** The label each owner page has in a breadcrumb. */
const OWNER_PAGE_LABELS = {
	automations: "Automations",
	connectors: "Connectors",
	settings: "Settings",
} as const;

/**
 * The head of the breadcrumb of an automation, a connector or a page of a
 * project's settings: its bot or project, then that one's `page`, which
 * leads back to it.
 */
export function OwnerPageCrumb({
	owner,
	page,
}: {
	owner: ResourceOwner;
	page: keyof typeof OWNER_PAGE_LABELS;
}) {
	return (
		<>
			<OwnerCrumb owner={owner} />
			<CrumbSeparator />
			<OwnerLink owner={owner} to={{ page }} className={cn(CRUMB, "shrink-0")}>
				{OWNER_PAGE_LABELS[page]}
			</OwnerLink>
		</>
	);
}
