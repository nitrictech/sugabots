import type { AttentionMark, NotificationSettings, Project } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Lock, Plus } from "lucide-react";
import { projectLink, projectNewChatLink, projectSettingsLink } from "@/lib/links.ts";
import { ownerMarkTransition } from "@/lib/owner-mark.ts";
import { useOwnerProblems } from "@/lib/owner-pages.ts";
import { projectPalettes } from "@/lib/project-looks.ts";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { hasNews, RowAttention } from "@/shell/SidebarBot.tsx";
import { ProblemMark } from "@/ui/attention-dot.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { initialOf } from "@/ui/letter-tile.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";

/** A project the viewer is in, with how its chats stand for them. */
export type ProjectStanding = AttentionMark & { project: Project };

/**
 * A project in the sidebar: one row, as a bot is, whose name opens the
 * project, where its chats are listed beside the rail. It says how much is
 * new in it, with an alert beside that while something is wrong that its
 * settings or automations set right, as a bot's row has, and is shaded while
 * the page open is in it. Under the pointer or on focus, New chat and its
 * settings come in at the end. Right-clicked, it
 * offers its notifications. A private project's name carries a lock.
 */
export function SidebarProject({
	standing,
	selected,
	notificationSettings,
}: {
	standing: ProjectStanding;
	/** Whether the page open is in this project. */
	selected: boolean;
	/** What the viewer is notified about, once loaded. */
	notificationSettings?: NotificationSettings;
}) {
	const { project } = standing;
	const problem = useProjectProblem(standing);
	const notificationPlace = { kind: "project", id: project.id } as const;
	const isPrivate = project.visibility === "private";
	return (
		<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
			<div
				className={cn(
					"group/project flex h-8 items-center rounded-sm pr-1.5 transition-colors",
					selected ? "bg-row-selected" : "hover:bg-row-hover",
				)}
			>
				<Link
					{...projectLink(project)}
					aria-current={selected ? "page" : undefined}
					className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm pl-2"
				>
					<span style={ownerMarkTransition(project.id)} className="flex shrink-0">
						<ProjectInitial project={project} size="nav" />
					</span>
					<span
						className={cn(
							"min-w-0 truncate text-sm",
							hasNews(standing)
								? "font-semibold text-foreground"
								: "font-medium text-muted-foreground group-hover/project:text-foreground",
						)}
					>
						{project.name}
					</span>
					{isPrivate && <PrivateMark />}
					<MutedMark settings={notificationSettings} place={notificationPlace} />
				</Link>
				<RowAttention
					unreadMessages={standing.unreadMessages}
					needsApproval={standing.needsApproval}
					className="mr-2"
				/>
				{problem && (
					<span className="mr-2 flex">
						<ProblemMark label={problem} />
					</span>
				)}
				<IconButton
					label={`New chat in ${project.name}`}
					size="sm"
					render={<Link {...projectNewChatLink(project)} />}
					className="hidden group-hover/project:grid group-has-focus-visible/project:grid"
				>
					<Plus strokeWidth={2.2} />
				</IconButton>
				<IconButton
					label={`${project.name} settings`}
					size="sm"
					render={<Link {...projectSettingsLink(project)} />}
					className="hidden group-hover/project:grid group-has-focus-visible/project:grid"
				>
					<SettingsIcon />
				</IconButton>
			</div>
		</NotificationsContextMenu>
	);
}

/**
 * What is wrong with a project that its settings or automations set right,
 * settings first.
 */
function useProjectProblem({ project, failedAutomations }: ProjectStanding): string | undefined {
	const problems = useOwnerProblems({ project }, failedAutomations > 0);
	return problems.settings ?? problems.automations;
}

/** The lock after a private project's name. */
export function PrivateMark() {
	return (
		<Lock
			role="img"
			aria-label="Private"
			size={11}
			strokeWidth={2.25}
			className="shrink-0 text-subtle-foreground"
		/>
	);
}

type ProjectMarkSource = Pick<Project, "name" | "color">;

/** How large a project's mark is drawn, from smallest to largest. */
const PROJECT_INITIAL_SIZES = {
	sm: "size-4 rounded text-3xs",
	md: "size-5 rounded-xs text-2xs",
	row: "size-7 rounded-sm text-xs",
	nav: "size-5.5 rounded-md text-2xs",
	lg: "size-11 rounded-xl text-sm",
	xl: "size-22 rounded-3xl text-3xl",
} as const;

/** A project as a small square holding its initial, in the project's colour. */
export function ProjectInitial({
	project,
	size = "md",
	className,
}: {
	/** Only what it is drawn from, so a project not made yet, such as New project's, can be drawn too. */
	project: ProjectMarkSource;
	/**
	 * `sm` is a quieter mark for a row that names its project: the letter in the
	 * project's colour on a tint of it. `row` heads a settings row, `nav` is
	 * the sidebar row's and the icon rail's alike, `lg` stands beside the title of the project's own
	 * settings, and `xl` heads a chat's details on a phone.
	 */
	size?: keyof typeof PROJECT_INITIAL_SIZES;
	className?: string;
}) {
	const palette = projectPalettes[project.color];
	const small = size === "sm";
	return (
		<span
			aria-hidden
			className={cn(
				"grid shrink-0 place-items-center font-semibold",
				PROJECT_INITIAL_SIZES[size],
				!small && "text-black/80",
				className,
			)}
			style={
				small ? { background: palette.tile, color: palette.swatch } : { background: palette.swatch }
			}
		>
			{initialOf(project.name)}
		</span>
	);
}
