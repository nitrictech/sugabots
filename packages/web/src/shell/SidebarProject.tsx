import type { NotificationSettings, Project } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Lock, Plus } from "lucide-react";
import { projectLink, projectNewThreadLink, projectSettingsLink } from "@/lib/links.ts";
import { projectPalettes } from "@/lib/project-looks.ts";
import type { useBackToHere } from "@/lib/settings-back.tsx";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { RowAttention } from "@/shell/SidebarBot.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";

/** A project the viewer is in, with how its threads stand for them. */
export interface ProjectStanding {
	project: Project;
	/** How many unread messages its threads hold. */
	unreadMessages: number;
	/** Whether a thread in it waits on the viewer. */
	needsApproval: boolean;
}

/** How a project stands while the sidebar's markers have nothing for it, or have not loaded. */
export const NOTHING_NEW_IN_PROJECT = { unreadMessages: 0, needsApproval: false };

/**
 * A project in the sidebar: one row, as a bot is, whose name opens the
 * project, where its threads are listed beside the rail. It says how much is
 * new in it, and is shaded while the page open is in it. Under the pointer or
 * on focus, New thread and its settings come in at the end. Right-clicked, it
 * offers its notifications. A private project's name carries a lock.
 */
export function SidebarProject({
	standing,
	selected,
	settingsBack,
	notificationSettings,
}: {
	standing: ProjectStanding;
	/** Whether the page open is in this project. */
	selected: boolean;
	/** History state for the settings link, so its Back returns to the page it left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	/** What the viewer is notified about, once loaded. */
	notificationSettings?: NotificationSettings;
}) {
	const { project } = standing;
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
					<ProjectInitial project={project} />
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
					{isPrivate && (
						<Lock
							aria-label="Private"
							size={11}
							strokeWidth={2.25}
							className="shrink-0 text-subtle-foreground"
						/>
					)}
					<MutedMark settings={notificationSettings} place={notificationPlace} />
				</Link>
				<RowAttention
					unreadMessages={standing.unreadMessages}
					needsApproval={standing.needsApproval}
					className="mr-2"
				/>
				<IconButton
					label={`New thread in ${project.name}`}
					size="sm"
					render={<Link {...projectNewThreadLink(project)} />}
					className="hidden group-hover/project:grid group-has-focus-visible/project:grid"
				>
					<Plus strokeWidth={2.2} />
				</IconButton>
				<IconButton
					label={`${project.name} settings`}
					size="sm"
					render={<Link {...projectSettingsLink(project)} state={settingsBack} />}
					className="hidden group-hover/project:grid group-has-focus-visible/project:grid"
				>
					<SettingsIcon />
				</IconButton>
			</div>
		</NotificationsContextMenu>
	);
}

function hasNews({ unreadMessages, needsApproval }: ProjectStanding): boolean {
	return needsApproval || unreadMessages > 0;
}

type ProjectMarkSource = Pick<Project, "name" | "color">;

/** How large a project's mark is drawn, from smallest to largest. */
const PROJECT_INITIAL_SIZES = {
	sm: "size-4 rounded text-3xs",
	md: "size-5 rounded-xs text-2xs",
	row: "size-7 rounded-sm text-xs",
	rail: "size-8 rounded-lg text-xs",
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
	 * project's colour on a tint of it. `row` heads a settings row, `rail` is
	 * the icon rail's, `lg` stands beside the title of the project's own
	 * settings, and `xl` heads a thread's details on a phone.
	 */
	size?: keyof typeof PROJECT_INITIAL_SIZES;
	className?: string;
}) {
	const palette = project.color === null ? undefined : projectPalettes[project.color];
	const small = size === "sm";
	return (
		<span
			aria-hidden
			className={cn(
				"grid shrink-0 place-items-center font-semibold",
				PROJECT_INITIAL_SIZES[size],
				!palette && "bg-tile text-foreground",
				palette && !small && "text-black/80",
				className,
			)}
			style={
				palette &&
				(small
					? { background: palette.tile, color: palette.swatch }
					: { background: palette.swatch })
			}
		>
			{Array.from(project.name.trim())[0]?.toUpperCase() ?? ""}
		</span>
	);
}
