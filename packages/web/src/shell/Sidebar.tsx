import type { Bot, NotificationSettings, Workspace } from "@sugabots/contracts";
import { Link, useMatchRoute, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Bot as BotIcon, ChevronRight, Hash, Plus } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { findBot, ownAssistants, useBots } from "@/lib/bots.ts";
import { useAttentionMarks } from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import { botsLink, projectsLink, settingsLink } from "@/lib/links.ts";
import { useNotificationSettings } from "@/lib/notifications.ts";
import { useOpenSettings } from "@/lib/open-settings.ts";
import { OWNER_PAGE_NAMES } from "@/lib/owner-pages.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { findProject, useProjects } from "@/lib/projects.ts";
import type { ResourceOwner } from "@/lib/resource-owner.tsx";
import { useSession, useSignOut } from "@/lib/session.ts";
import { useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { AccountMenu } from "@/shell/AccountMenu.tsx";
import { HelpMenu } from "@/shell/HelpMenu.tsx";
import { IconRail } from "@/shell/IconRail.tsx";
import { useNewBot } from "@/shell/NewBot.tsx";
import { useNewProject } from "@/shell/NewProject.tsx";
import { OwnerSidebar, type OwnerSidebarPage } from "@/shell/OwnerSidebar.tsx";
import { type BotStanding, SidebarBot } from "@/shell/SidebarBot.tsx";
import { type ProjectWithAttention, SidebarProject } from "@/shell/SidebarProject.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";

/**
 * How wide the sidebar is until the viewer drags it, and how narrow it can
 * go, in pixels. On a bot's or project's pages the icon rail is part of it, so
 * the page beside starts at the same place on every page; the narrowest still
 * leaves a bot's or project's own sidebar room beside the rail.
 */
const SIDEBAR_DEFAULT_WIDTH_PX = 288;
const SIDEBAR_MIN_WIDTH_PX = 256;

/** What the sidebar shades as open besides a bot or project: settings, or the project directory. */
export type SidebarView = "settings" | "projects";

/**
 * The column down the left. While the address is one of a bot's or a
 * project's pages (the bot or project itself, a chat, its files or its
 * automations), the workspace narrowed to `IconRail` at the far left, and
 * beside it that bot's or project's own sidebar, `OwnerSidebar`. Everywhere
 * else: the member's Personal Assistants, the projects they are in, the bots
 * they pinned, and you, Settings and Help at the foot. Its top is always left
 * clear for the button that puts it away, which sits over it while a chat is
 * open, so what is under it never moves; without `resizable`, its edge does
 * not drag. A phone has `MobileTabBar` and
 * `MobileHome` instead.
 */
export function Sidebar({ resizable = true }: { resizable?: boolean }) {
	const { data: projects } = useProjects();
	const { bots } = useBots();
	const assistants = ownAssistants(bots);
	const { attentionMarkOf } = useAttentionMarks();
	const { data: notificationSettings } = useNotificationSettings();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	const session = useSession();
	const signOut = useSignOut();
	const place = useSidebarPlace();
	const newBot = useNewBot();
	const newProject = useNewProject();
	const assistantStandings = assistants.map((assistant) => ({
		bot: assistant,
		...attentionMarkOf(assistant.defaultProjectId),
	}));
	const projectStandings = (projects ?? [])
		.filter((project) => project.isMember)
		.map((project) => ({ project, ...attentionMarkOf(project.id) }));
	const botStandings = sidebarBots(bots ?? []).map((bot) => ({
		bot,
		...attentionMarkOf(bot.defaultProjectId),
	}));
	const owner = useOwnerInView(place);

	return (
		<>
			<SidebarView
				assistants={assistantStandings}
				projects={projectStandings}
				bots={botStandings}
				currentProjectSlug={place.projectSlug}
				currentBotHandle={place.botHandle}
				assistantOpen={place.atHome}
				view={place.view}
				workspace={workspace}
				workspaces={workspaces ?? []}
				signedIn={session.member ?? undefined}
				notificationSettings={notificationSettings}
				onSignOut={() => void signOut()}
				onNewBot={newBot.start}
				onNewProject={newProject.start}
				resizable={resizable}
				rail={
					owner && (
						<IconRail
							projects={projectStandings}
							assistants={assistantStandings}
							bots={botStandings}
							currentProjectSlug={place.projectSlug}
							currentBotHandle={place.botHandle}
						/>
					)
				}
				focus={
					owner && (
						<OwnerSidebar
							key={"bot" in owner ? owner.bot.id : owner.project.id}
							owner={owner}
							selectedChatId={place.chatId}
							page={place.ownerPage}
						/>
					)
				}
				// A phone has its tabs instead, and Home in place of the projects.
				className="max-md:hidden"
			/>
			{newBot.dialog}
			{newProject.dialog}
		</>
	);
}

/** The bots the sidebar lists, besides Personal Assistants: those the member pinned and may use. */
export function sidebarBots(bots: readonly Bot[]): Bot[] {
	return bots.filter((bot) => bot.pinned && !bot.assistant && bot.permissions.talk);
}

/**
 * The bot or project whose pages the address is on, which the sidebar narrows
 * to beside: a bot the member talks to, or a project they are in. Someone
 * else's personal bot, which an administrator only sees listed, and a project
 * the member has not joined, have none.
 */
function useOwnerInView(place: SidebarPlace): ResourceOwner | undefined {
	const { bots } = useBots();
	const { data: projects } = useProjects();
	const bot = place.botHandle === undefined ? undefined : findBot(bots, place.botHandle);
	if (bot?.permissions.talk) return { bot };
	const project =
		place.projectSlug === undefined ? undefined : findProject(projects, place.projectSlug);
	if (project?.isMember) return { project };
	return undefined;
}

/** Where the address is, as the sidebar marks it. */
interface SidebarPlace {
	/** The project the address is in, if any. */
	projectSlug: string | undefined;
	/** The bot the address is in, if any. */
	botHandle: string | undefined;
	/** Which of the bot's or project's own pages is open, if one is. */
	ownerPage: OwnerSidebarPage;
	/** Whether the workspace's home is open, which is the oldest Personal Assistant's page. */
	atHome: boolean;
	/** The chat open, if one is. */
	chatId: string | undefined;
	view: SidebarView | undefined;
}

function useSidebarPlace(): SidebarPlace {
	const matchRoute = useMatchRoute();
	const { project, bot, chat } = useParams({ strict: false });
	const settingsOpen = useOpenSettings() !== undefined;
	const view: SidebarView | undefined = settingsOpen
		? "settings"
		: matchRoute({ to: "/$workspace/projects" })
			? "projects"
			: undefined;
	return {
		projectSlug: project,
		botHandle: bot,
		ownerPage: OWNER_PAGE_NAMES.find(
			(page) =>
				matchRoute({ to: `/$workspace/bots/$bot/${page}`, fuzzy: true }) ||
				matchRoute({ to: `/$workspace/projects/$project/${page}`, fuzzy: true }),
		),
		atHome: Boolean(matchRoute({ to: "/$workspace" })),
		chatId: chat,
		view,
	};
}

export function SidebarView({
	assistants = [],
	projects,
	bots,
	currentProjectSlug,
	currentBotHandle,
	assistantOpen = false,
	view,
	workspace,
	workspaces = [],
	signedIn,
	notificationSettings,
	onSignOut,
	onNewBot,
	onNewProject,
	resizable = true,
	rail,
	focus,
	className,
}: {
	/** The viewer's Personal Assistants, oldest first, with how each stands. */
	assistants?: readonly BotStanding[];
	/** The projects the viewer is in, with how each stands. */
	projects: readonly ProjectWithAttention[];
	/** The bots the viewer pinned, with how each stands. */
	bots: readonly BotStanding[];
	/** The project the page open is in, while it is in one. */
	currentProjectSlug?: string;
	/** The bot the page open is about, while it is about one. */
	currentBotHandle?: string;
	/** Whether the oldest Personal Assistant's page is open as the workspace's home. */
	assistantOpen?: boolean;
	view: SidebarView | undefined;
	workspace?: Workspace;
	/** Every workspace the viewer belongs to, which your menu offers to switch to. */
	workspaces?: readonly Workspace[];
	signedIn?: { name: string; email: string; image?: string | null };
	/** What the viewer is notified about, once loaded, which a project's menu changes. */
	notificationSettings?: NotificationSettings;
	onSignOut: () => void;
	/** Absent when the viewer may not make a bot. */
	onNewBot?: () => void;
	/** Absent when the viewer may not make a project. */
	onNewProject?: () => void;
	/** Whether its edge drags to change its width. */
	resizable?: boolean;
	/** At the far left, before it, as the workspace narrows to on a bot's or a project's pages. */
	rail?: ReactNode;
	/** Shown in place of the projects and bots, as a bot's or project's own sidebar is on its pages. */
	focus?: ReactNode;
	className?: string;
}) {
	const [folded, toggleFolded] = useFolded();
	const [width, setWidth] = usePaneWidth("sidebar");
	// The rail and the sidebar beside it are sized together, so one width holds on every page.
	const pane = useRef<HTMLDivElement>(null);
	return (
		<div
			ref={pane}
			className={cn(
				"flex min-h-0 shrink-0 max-md:flex-1 md:w-(--sidebar-width) md:max-w-100",
				className,
			)}
			style={{ "--sidebar-width": `${width ?? SIDEBAR_DEFAULT_WIDTH_PX}px` } as CSSProperties}
		>
			{rail}
			<nav
				aria-label="Sidebar"
				className={cn(
					"@container/sidebar relative flex min-h-0 min-w-0 flex-1 flex-col bg-rail",
					// A rule between the rail and a bot's or project's sidebar, which share its colour.
					rail && "md:border-border md:border-s",
				)}
			>
				{resizable && (
					<ResizeHandle
						label="Resize the sidebar"
						pane={pane}
						edge="end"
						min={SIDEBAR_MIN_WIDTH_PX}
						onResize={setWidth}
					/>
				)}
				{!focus && <div aria-hidden className="h-10 shrink-0" />}
				{/* Named for the view transition that slides one out and the other in. */}
				{focus ? (
					<div className="flex min-h-0 flex-1 flex-col view-transition-owner-sidebar">{focus}</div>
				) : (
					<div className="scrollbar-on-hover flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-3 view-transition-workspace-sidebar">
						{/* Personal Assistants always lead, above everything they can help with. */}
						{assistants.length > 0 && (
							<ul className="m-0 flex list-none flex-col p-0">
								{assistants.map((assistant, place) => (
									<SidebarBot
										key={assistant.bot.id}
										standing={assistant}
										selected={
											(assistantOpen && place === 0) || assistant.bot.handle === currentBotHandle
										}
										notificationSettings={notificationSettings}
									/>
								))}
							</ul>
						)}
						<FoldSection
							title="Projects"
							open={!folded.has(PROJECTS_FOLD)}
							onToggle={() => toggleFolded(PROJECTS_FOLD)}
							action={
								<>
									<IconButton
										label="Browse projects"
										size="sm"
										render={<Link {...projectsLink()} />}
									>
										<Hash strokeWidth={2.2} />
									</IconButton>
									{onNewProject && (
										<IconButton label="New project" size="sm" onClick={onNewProject}>
											<Plus strokeWidth={2.2} />
										</IconButton>
									)}
								</>
							}
						>
							{projects.map((projectWithAttention) => (
								<SidebarProject
									key={projectWithAttention.project.id}
									projectWithAttention={projectWithAttention}
									selected={projectWithAttention.project.slug === currentProjectSlug}
									notificationSettings={notificationSettings}
								/>
							))}
							{projects.length === 0 && (
								<Link
									{...projectsLink()}
									aria-current={view === "projects" ? "page" : undefined}
									className={sidebarRow({ selected: view === "projects" })}
								>
									<Hash aria-hidden size={16} strokeWidth={2} className="mx-px shrink-0" />
									<span className="min-w-0 flex-1 truncate">Join a project</span>
								</Link>
							)}
						</FoldSection>
						<FoldSection
							title="Bots"
							open={!folded.has(BOTS_FOLD)}
							onToggle={() => toggleFolded(BOTS_FOLD)}
							action={
								<>
									<IconButton label="Browse bots" size="sm" render={<Link {...botsLink()} />}>
										<BotIcon strokeWidth={2.2} />
									</IconButton>
									{onNewBot && (
										<IconButton label="New bot" size="sm" onClick={onNewBot}>
											<Plus strokeWidth={2.2} />
										</IconButton>
									)}
								</>
							}
						>
							<ul className="m-0 flex list-none flex-col gap-px p-0">
								{bots.map((standing) => (
									<SidebarBot
										key={standing.bot.id}
										standing={standing}
										selected={standing.bot.handle === currentBotHandle}
										notificationSettings={notificationSettings}
									/>
								))}
							</ul>
						</FoldSection>
					</div>
				)}
				<div className="mt-auto flex items-center gap-1.5 border-border border-t px-3 py-2">
					{signedIn && workspace ? (
						<AccountMenu
							signedIn={signedIn}
							current={workspace}
							workspaces={workspaces}
							onSignOut={onSignOut}
						/>
					) : (
						<span className="flex-1" />
					)}
					{workspace && (
						<IconButton
							label="Settings"
							side="top"
							aria-current={view === "settings" ? "page" : undefined}
							variant="row"
							render={<Link {...settingsLink()} />}
							className="size-7 text-muted-foreground [&_svg]:size-4"
						>
							<SettingsIcon />
						</IconButton>
					)}
					<HelpMenu />
				</div>
			</nav>
		</div>
	);
}

/** What the sidebar remembers the Projects and Bots headings folded by. */
const PROJECTS_FOLD = "projects";
const BOTS_FOLD = "bots";

/**
 * One of the sidebar's sections, Projects or Bots, beneath a heading that is
 * only its name and folds it away, with a chevron after the name and `action`
 * at its end while the heading is pointed at.
 */
function FoldSection({
	title,
	open,
	onToggle,
	action,
	children,
}: {
	title: string;
	open: boolean;
	onToggle: () => void;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		// A group rather than a region: the sidebar is already a landmark, and a page beside it
		// may have its own region of the same name, such as a settings group of projects.
		// biome-ignore lint/a11y/useSemanticElements: this groups links, not form controls, so a fieldset is wrong.
		<div role="group" aria-label={title} className="flex flex-col gap-px">
			<div className="group/section flex h-8 items-center rounded-sm pr-1.5">
				<h2 className="m-0 flex min-w-0 flex-1 font-normal">
					<button
						type="button"
						aria-expanded={open}
						onClick={onToggle}
						// The whole bar but its buttons folds the section, not just its name.
						className="focus-ring flex h-8 min-w-0 flex-1 items-center gap-1 rounded-sm pl-2 text-left"
					>
						<span className="min-w-0 truncate font-medium text-muted-foreground text-xs group-hover/section:text-foreground">
							{title}
						</span>
						<ChevronRight
							aria-hidden
							size={12}
							strokeWidth={2.25}
							className={cn(
								"invisible shrink-0 text-muted-foreground transition-transform group-hover/section:visible group-has-focus-visible/section:visible",
								open && "rotate-90",
							)}
						/>
					</button>
				</h2>
				{action && (
					<span className="flex items-center opacity-0 transition-opacity group-hover/section:opacity-100 group-has-focus-visible/section:opacity-100">
						{action}
					</span>
				)}
			</div>
			{/* Level with the heading, not nested under it. */}
			{open && <div className="flex flex-col gap-px">{children}</div>}
		</div>
	);
}
