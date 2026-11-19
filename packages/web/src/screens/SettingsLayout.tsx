import { useRender } from "@base-ui/react/use-render";
import type { Bot, Project } from "@sugabots/contracts";
import {
	type HistoryState,
	Link,
	Navigate,
	useLocation,
	useMatch,
	useNavigate,
} from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Plus, X } from "lucide-react";
import {
	cloneElement,
	Fragment,
	type ReactElement,
	type ReactNode,
	Suspense,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { findBot, useBots } from "@/lib/bots.ts";
import { botSettingsLink, projectSettingsLink, projectSettingsPageLink } from "@/lib/links.ts";
import { matchesMedia, SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import { LIST_MIN_WIDTH_PX, usePaneWidth } from "@/lib/pane-width.ts";
import { findProject, useProjectBots, useProjectMembers, useProjects } from "@/lib/projects.ts";
import { useSession } from "@/lib/session.ts";
import { useBackTarget, useSettingsBack } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaceMembers, useWorkspacePermissions } from "@/lib/workspace.ts";
import {
	botSettingsPage,
	botSettingsPages,
	projectSettingsPage,
	projectSettingsPages,
	type SettingSection,
	workspaceSettingSection,
	workspaceSettingSections,
	yourSettingSections,
} from "@/lib/workspace-settings.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { NewProjectDialog } from "@/shell/NewProject.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import {
	type BackTarget,
	CompactBackBar,
	SETTINGS_CARD,
	SettingsGroup,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";

/**
 * Settings, from a tablet up as a dialog over the dimmed app: the workspace's
 * sections, each project's pages and each bot down the left, the open page
 * beside them under a trail of where it sits. Below a laptop's width there is no room for both, so
 * settings drill down as a phone's do: the sections as one list, and each
 * opening with a way back to it.
 *
 * The frame is deliberately NOT part of the settings bundle. The sections
 * behind it are a chunk of their own, and while it is on its way the click has
 * to land on something: the navigation is there to choose from, and the
 * section fills in beside it.
 */
export function SettingsLayout({
	index = false,
	children,
}: {
	/** Whether this is `/settings` itself, which on a phone or tablet is the list of sections. */
	index?: boolean;
	children: ReactNode;
}) {
	const pathname = useSettingsPath();
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	// A phone lists settings in its You tab.
	if (index && phone) return <Navigate from="/$workspace" to="./you" replace />;
	return (
		// From a tablet up, a dialog over the dimmed app, which closes back to where it was opened.
		<div className="contents md:fixed md:inset-0 md:z-50 md:flex md:items-center md:justify-center md:p-10">
			<SettingsClose backdrop />
			{/* A group, so the frame's Back can stand aside for one the page draws itself. */}
			<div
				{...(phone ? {} : { role: "dialog", "aria-modal": true, "aria-label": "Settings" })}
				className="group/settings flex min-h-0 min-w-0 flex-1 md:relative md:h-full md:w-full md:overflow-hidden md:rounded-xl md:border md:border-border-strong md:bg-background md:shadow-dialog"
			>
				<SettingsClose />
				<SettingsNavigation />
				{index && <CompactSettingsList />}
				<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", index && "max-lg:hidden")}>
					<SettingsTrail className="max-lg:hidden" />
					{/*
					 * The scrollbar's room is kept whether or not the page is long enough
					 * to need one, so a long page, such as Usage, centres its column where
					 * a short one does.
					 */}
					<main
						data-scroll-restoration-id="settings"
						className="tab-bar-clearance relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background scrollbar-gutter-stable max-md:scrollbar-gutter-auto"
					>
						{!index && (
							<CompactPageBackBar
								parent={phone ? phoneParentPage(pathname) : parentPage(pathname)}
							/>
						)}
						{/*
						 * Nothing rather than a skeleton: the navigation has already answered
						 * the click, and a shape that flashes beside it reads as a fault.
						 */}
						<Suspense fallback={null}>{children}</Suspense>
					</main>
				</div>
			</div>
		</div>
	);
}

/**
 * Closes the settings dialog, back to the page it was opened from, else the
 * workspace's home: the × in its corner, or as `backdrop`, the dimmed app
 * around it. A phone, whose settings are pages, has neither.
 */
function SettingsClose({ backdrop = false }: { backdrop?: boolean }) {
	const back = useSettingsBack();
	const { workspace } = useWorkspace();
	const close = useRef<HTMLButtonElement>(null);
	// Escape closes it wherever the focus is, unless something inside used the key, as a menu does.
	useEffect(() => {
		if (backdrop) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && matchesMedia(SIDE_BY_SIDE)) {
				close.current?.click();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [backdrop]);
	const to = back?.render ?? (
		<Link to="/$workspace" params={{ workspace: workspace?.slug ?? "" }} />
	);
	if (backdrop) return <SettingsBackdrop render={to} />;
	return (
		<IconButton
			ref={close}
			label="Close settings"
			render={to}
			className="absolute top-2.5 right-3 z-10 hidden md:inline-grid"
		>
			<X aria-hidden />
		</IconButton>
	);
}

/** The dimmed app around the settings dialog, which closes it when clicked, as the × does. */
function SettingsBackdrop({ render }: { render: useRender.RenderProp }) {
	return useRender({
		render,
		props: {
			"aria-label": "Close settings",
			tabIndex: -1,
			className: "absolute inset-0 hidden cursor-default bg-scrim md:block",
		},
	});
}

/**
 * On a phone or tablet, where there is no trail, the bar above a page with
 * its Back: where you came from, or else the page it sits under. A page that
 * draws a Back of its own is left to it.
 */
function CompactPageBackBar({ parent }: { parent: BackTarget }) {
	const back = useBackTarget(parent);
	return (
		<CompactBackBar {...back} className="group-has-[[data-page-back]]/settings:hidden lg:hidden" />
	);
}

const settingsList: BackTarget = {
	label: "Settings",
	render: <Link from="/$workspace" to="./settings" />,
};

/** The page `pathname` sits under, for its Back when nothing says where you came from. */
function parentPage(pathname: string): BackTarget {
	const [, sectionId, item, page] = pathname.split("/").filter(Boolean);
	// One of a bot's own pages goes back to the bot.
	if (sectionId === "bots" && item !== undefined && page !== undefined) {
		return {
			label: "Bot",
			render: <Link {...botSettingsLink({ handle: item })} />,
		};
	}
	if (sectionId === "projects" && item !== undefined && page !== undefined) {
		return {
			label: "Project",
			render: <Link {...projectSettingsLink({ slug: item })} />,
		};
	}
	// A project's own page is one of the navigation's, so it sits under the list itself.
	if (sectionId !== undefined && sectionId !== "projects" && item !== undefined) {
		const section = workspaceSettingSection(sectionId);
		if (section) {
			return {
				label: section.label,
				render: (
					<Link from="/$workspace" to="./settings/$section" params={{ section: section.id }} />
				),
			};
		}
	}
	return settingsList;
}

/**
 * The page `pathname` sits under on a phone, whose settings are listed in its
 * You tab: Notifications under your profile, and what would sit under the
 * list of settings under the tab.
 */
function phoneParentPage(pathname: string): BackTarget {
	const [, sectionId] = pathname.split("/").filter(Boolean);
	// Opened from a row on your profile.
	if (sectionId === "notifications") {
		return {
			label: "You",
			render: <Link from="/$workspace" to="./settings/$section" params={{ section: "profile" }} />,
		};
	}
	const parent = parentPage(pathname);
	if (parent !== settingsList) return parent;
	return { label: "Settings", render: <Link from="/$workspace" to="./you" /> };
}

/** The workspace's sections the viewer may open, with what each holds. */
function useWorkspaceSections() {
	const may = useWorkspacePermissions();
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	// The one member a workspace always has is you, so the roster starts at two.
	const people = members?.length;
	const counts: Partial<Record<SettingSection["id"], number | undefined>> = {
		members: people === 1 ? undefined : people,
	};
	const sections = workspaceSettingSections.filter(
		(section: SettingSection) => !("needs" in section) || may[section.needs],
	);
	return { sections, counts };
}

/** The projects you are in and the bots you reach, as the navigation lists them. */
function useListed() {
	const { data: projects } = useProjects();
	const { bots } = useBots();
	return {
		projects: projects?.filter((project) => project.isMember) ?? [],
		bots: bots ?? [],
	};
}

/** How wide the navigation can be dragged: a third of the window, so the page beside it keeps its room. */
const NAVIGATION_MAX_WIDTH = "33vw";

function SettingsNavigation() {
	const { sections, counts } = useWorkspaceSections();
	const { projects, bots } = useListed();
	const may = useWorkspacePermissions();
	const session = useSession();
	const pathname = useSettingsPath();
	const navigation = useRef<HTMLElement>(null);
	const [width, setWidth] = usePaneWidth("settings-navigation");

	return (
		<nav
			ref={navigation}
			aria-label="Settings"
			// As wide as Inbox's list at its narrowest until dragged wider, and no wider than a third of the window.
			style={{
				width: `clamp(${LIST_MIN_WIDTH_PX}px, ${width ?? LIST_MIN_WIDTH_PX}px, ${NAVIGATION_MAX_WIDTH})`,
			}}
			className="relative flex min-h-0 shrink-0 flex-col border-border border-r max-lg:hidden"
		>
			<ResizeHandle
				label="Resize the settings navigation"
				pane={navigation}
				edge="end"
				min={LIST_MIN_WIDTH_PX}
				onResize={setWidth}
			/>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-3 pb-3">
				{/* Your own settings first: they follow you from workspace to workspace. */}
				{session.user && (
					<NavigationGroup label="You">
						{yourSettingSections.map((section) => (
							<SectionLink
								key={section.id}
								section={section}
								selected={isSelected(section, pathname)}
								count={undefined}
							/>
						))}
					</NavigationGroup>
				)}
				<NavigationGroup label="Workspace">
					{sections.map((section) => (
						<SectionLink
							key={section.id}
							section={section}
							selected={isSelected(section, pathname)}
							count={counts[section.id]}
						/>
					))}
				</NavigationGroup>
				{(projects.length > 0 || may.createProjects) && (
					<NavigationGroup label="Projects" action={may.createProjects && <NewProjectButton />}>
						{projects.map((project) => (
							<ProjectNavigation key={project.id} project={project} pathname={pathname} />
						))}
					</NavigationGroup>
				)}
				{bots.length > 0 && (
					<NavigationGroup label="Bots">
						{bots.map((bot) => (
							<BotNavigation key={bot.id} bot={bot} pathname={pathname} />
						))}
					</NavigationGroup>
				)}
			</div>
		</nav>
	);
}

function NavigationGroup({
	label,
	action,
	children,
}: {
	label: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		// Named by its heading, so the General under You is told apart from the workspace's.
		// biome-ignore lint/a11y/useSemanticElements: this groups links, not form controls, so a fieldset is wrong.
		<div role="group" aria-labelledby={headingId} className="flex flex-col gap-px">
			{/* A sidebar row's height, so the first heading lines up with Inbox across from it. */}
			<div className="flex h-8 items-center gap-2 pr-1.5 pl-2">
				<h2 id={headingId} className="m-0 flex-1 font-medium text-subtle-foreground text-xs">
					{label}
				</h2>
				{action}
			</div>
			{children}
		</div>
	);
}

/**
 * What sits at a line's right: a count, a project's chevron, the + beside Projects.
 * One width for all, centred in it, so they line up down the navigation.
 */
const TRAILING_SLOT = "grid w-5.5 shrink-0 place-items-center";

/** One line of the navigation, picked out when it is the open page. */
const NAVIGATION_ITEM =
	"focus-ring flex h-8 min-w-0 items-center rounded-sm pr-1.5 pl-2 text-sm transition-colors";

function navigationItemState(selected: boolean) {
	return selected
		? "bg-row-selected text-foreground"
		: "text-muted-foreground hover:bg-row-hover hover:text-foreground";
}

function NavigationItemContent({ label, count }: { label: string; count?: number }) {
	return (
		<>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count !== undefined && (
				<span
					aria-hidden="true"
					className={cn(TRAILING_SLOT, "text-subtle-foreground text-xs tabular-nums")}
				>
					{count}
				</span>
			)}
		</>
	);
}

/** A bot in the navigation, picked out while one of its pages is open. */
function BotNavigation({ bot, pathname }: { bot: Bot; pathname: string }) {
	const [, section, handle] = pathname.split("/").filter(Boolean);
	const selected = section === "bots" && handle === bot.handle;
	return (
		<Link
			{...botSettingsLink(bot)}
			aria-current={selected ? "page" : undefined}
			className={cn(NAVIGATION_ITEM, "gap-2.5", navigationItemState(selected))}
		>
			<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={16} />
			<NavigationItemContent label={bot.name} />
		</Link>
	);
}

/**
 * A project in the navigation, opening onto its pages. The project you are
 * on stays open; the others open and close as you choose.
 */
function ProjectNavigation({ project, pathname }: { project: Project; pathname: string }) {
	const openPage = projectPageAt(pathname, project);
	const [chosenOpen, setChosenOpen] = useRememberedOpen(project.id);
	// Opened or closed as last chosen on this device; until then, open while you are on one of its pages.
	const open = chosenOpen ?? openPage !== undefined;
	const counts = useProjectCounts(project, open);
	const listId = `settings-project-${project.id}`;
	return (
		<div className="flex flex-col gap-px">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setChosenOpen(!open)}
				className={cn(
					"focus-ring flex h-8 items-center gap-2.5 rounded-sm pr-1.5 pl-2 text-left text-sm transition-colors hover:bg-row-hover hover:text-foreground",
					openPage ? "text-foreground" : "text-muted-foreground",
				)}
			>
				<ProjectInitial project={project} size="sm" />
				<span className="min-w-0 flex-1 truncate">{project.name}</span>
				<span aria-hidden className={TRAILING_SLOT}>
					<ChevronRight
						size={12}
						strokeWidth={2}
						className={cn("text-subtle-foreground transition-transform", open && "rotate-90")}
					/>
				</span>
			</button>
			{open && (
				<div
					id={listId}
					className="mb-1 ml-4 flex flex-col gap-px border-border-strong border-l pl-2"
				>
					{projectSettingsPages.map((page) => {
						const selected = openPage === page.id;
						const className = cn(NAVIGATION_ITEM, navigationItemState(selected));
						const count = counts[page.id];
						const current = selected ? "page" : undefined;
						const label = count === undefined ? undefined : `${page.label}, ${count}`;
						return (
							<Link
								key={page.id}
								{...projectSettingsPageLink(project, page.id)}
								aria-label={label}
								aria-current={current}
								className={className}
							>
								<NavigationItemContent label={page.label} count={count} />
							</Link>
						);
					})}
				</div>
			)}
		</div>
	);
}

const OPEN_PROJECTS_KEY = "sugabots-settings-open-projects";

/**
 * Whether `projectId` was last opened or closed in the navigation on this device,
 * and the way to choose: undefined until somebody does. Kept in the browser,
 * like a pane's width, so it survives leaving settings and reloading.
 */
function useRememberedOpen(projectId: string): [boolean | undefined, (open: boolean) => void] {
	const [chosen, setChosen] = useState(() => storedOpenProjects()[projectId]);
	const choose = (open: boolean) => {
		setChosen(open);
		try {
			localStorage.setItem(
				OPEN_PROJECTS_KEY,
				JSON.stringify({ ...storedOpenProjects(), [projectId]: open }),
			);
		} catch {
			// Storage can be off. The choice still holds until the page is left.
		}
	};
	return [chosen, choose];
}

function storedOpenProjects(): Record<string, boolean> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(OPEN_PROJECTS_KEY) ?? "{}");
		if (typeof stored !== "object" || stored === null) return {};
		return Object.fromEntries(
			Object.entries(stored).filter(
				(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
			),
		);
	} catch {
		return {};
	}
}

/** What each of a project's pages holds, counted once the project is open in the navigation. */
function useProjectCounts(project: Project, open: boolean): Partial<Record<string, number>> {
	const members = useProjectMembers(open ? project.id : undefined);
	const bots = useProjectBots(open ? project.id : undefined);
	return {
		people: members.data?.length || undefined,
		bots: bots.data?.length || undefined,
	};
}

/** Makes a project and opens its settings: the + beside Projects in the navigation. */
function NewProjectButton() {
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	return (
		<>
			<IconButton
				label="New project"
				size="sm"
				onClick={() => setCreating(true)}
				className={cn(
					TRAILING_SLOT,
					"h-5.5 rounded-xs text-subtle-foreground hover:bg-row-hover [&_svg]:size-3.25",
				)}
			>
				<Plus strokeWidth={2} />
			</IconButton>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewProjectDialog
					onCreated={async (project) => {
						setCreating(false);
						await navigate(projectSettingsLink(project));
					}}
				/>
			</Dialog>
		</>
	);
}

/**
 * Settings on a tablet: one list, as a phone's own settings are, with you at
 * the top and every section a row that opens it full screen. The sidebar
 * beside it is the way out, so it has no Done.
 */
function CompactSettingsList() {
	return (
		<nav
			aria-label="Settings sections"
			className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto bg-background px-4 pt-4 pb-8 *:mx-auto *:w-full *:max-w-155 *:shrink-0 md:px-8 md:pt-9 lg:hidden"
		>
			<h1 className="m-0 font-semibold text-3xl text-foreground tracking-tight">Settings</h1>
			<SettingsListGroups />
		</nav>
	);
}

/**
 * The groups of the list of settings: you, the workspace's sections, its
 * projects and its bots. A phone's You tab lists them too, with `linkState`
 * saying where each page's Back returns.
 */
export function SettingsListGroups({
	linkState,
}: {
	linkState?: (state: HistoryState) => HistoryState;
}) {
	const { sections, counts } = useWorkspaceSections();
	const { projects, bots } = useListed();
	const { user } = useSession();
	return (
		<>
			{/* You first, on a card that opens your profile, which leads on to your Notifications. */}
			{user && (
				<Link
					from="/$workspace"
					to="./settings/$section"
					params={{ section: "profile" }}
					state={linkState}
					className={cn(
						SETTINGS_CARD,
						"focus-ring flex shrink-0 items-center gap-4 px-4 py-4 active:bg-row-selected",
					)}
				>
					<PersonAvatar person={user} size={64} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate font-semibold text-xl text-foreground">{user.name}</span>
						<span className="truncate text-sm text-subtle-foreground">
							Profile and notifications
						</span>
					</span>
					<ChevronRight aria-hidden size={18} className="shrink-0 text-subtle-foreground" />
				</Link>
			)}
			<SettingsGroup label="Workspace" headingLevel={2}>
				{sections.map((section) => (
					<SettingsRow
						key={section.id}
						label={section.label}
						trailing={
							counts[section.id] !== undefined && (
								<SettingsValue>{counts[section.id]}</SettingsValue>
							)
						}
						chevron
						render={
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: section.id }}
								state={linkState}
							/>
						}
					/>
				))}
			</SettingsGroup>
			{projects.length > 0 && (
				<SettingsGroup label="Projects" headingLevel={2}>
					{projects.map((project) => (
						<SettingsRow
							key={project.id}
							icon={<ProjectInitial project={project} size="sm" />}
							label={project.name}
							chevron
							render={<Link {...projectSettingsLink(project)} state={linkState} />}
						/>
					))}
				</SettingsGroup>
			)}
			{bots.length > 0 && (
				<SettingsGroup label="Bots" headingLevel={2}>
					{bots.map((bot) => (
						<SettingsRow
							key={bot.id}
							icon={<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={20} />}
							label={bot.name}
							chevron
							render={<Link {...botSettingsLink(bot)} state={linkState} />}
						/>
					))}
				</SettingsGroup>
			)}
		</>
	);
}

/**
 * The trail across the top of a settings page on a wide screen: whose
 * settings these are, then each page on the way down to this one, each a
 * link back up but the last.
 */
function SettingsTrail({ className }: { className: string }) {
	const crumbs = useSettingsCrumbs();
	return (
		<nav
			aria-label="Breadcrumb"
			className={cn("flex h-13 shrink-0 items-center border-border border-b pr-14 pl-6", className)}
		>
			<ol className="m-0 flex min-w-0 list-none items-center gap-2.5 p-0 text-xs">
				{crumbs.map((crumb, index) => {
					const last = index === crumbs.length - 1;
					return (
						// Positions don't move, so the index names each crumb well enough.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						<Fragment key={index}>
							{index > 0 && (
								<li aria-hidden className="text-disabled-foreground">
									/
								</li>
							)}
							<li className="min-w-0 truncate">
								{last || !crumb.link ? (
									<span
										aria-current={last ? "page" : undefined}
										className={last ? "text-foreground" : "text-muted-foreground"}
									>
										{crumb.label}
									</span>
								) : (
									<CrumbLink link={crumb.link}>{crumb.label}</CrumbLink>
								)}
							</li>
						</Fragment>
					);
				})}
			</ol>
		</nav>
	);
}

function CrumbLink({ link, children }: { link: ReactElement; children: ReactNode }) {
	return cloneElement(link, {
		className:
			"focus-ring whitespace-nowrap rounded-sm text-muted-foreground transition-colors hover:text-foreground",
		children,
	} as Partial<unknown>);
}

interface Crumb {
	label: ReactNode;
	/** The page it names, as the link element to render: `<Link … />`. Absent for the page itself. */
	link?: ReactElement;
}

const workspaceCrumb: Crumb = {
	label: "Workspace settings",
	link: <Link from="/$workspace" to="./settings" />,
};

function sectionCrumb(id: SettingSection["id"]): Crumb {
	const section = workspaceSettingSection(id);
	return {
		label: section?.label ?? id,
		link: <Link from="/$workspace" to="./settings/$section" params={{ section: id }} />,
	};
}

/** The trail to the open page, read from its address. */
function useSettingsCrumbs(): Crumb[] {
	const pathname = useSettingsPath();
	const { data: projects } = useProjects();
	const { bots } = useBots();
	const [, sectionId, item, page] = pathname.split("/").filter(Boolean);
	if (sectionId === undefined || sectionId === "general") {
		return [workspaceCrumb, { label: "General" }];
	}
	const yours = yourSettingSections.find((section) => section.id === sectionId);
	if (yours) {
		return [{ label: "Your settings" }, { label: yours.label }];
	}
	if (sectionId === "projects" && item !== undefined) {
		const project = findProject(projects, item);
		return project ? projectCrumbs(project, page) : [];
	}
	if (sectionId === "bots" && item !== undefined) {
		const bot = findBot(bots, item);
		return bot ? botCrumbs(bot, page) : [];
	}
	if (item === undefined) {
		return [workspaceCrumb, { label: workspaceSettingSection(sectionId)?.label ?? sectionId }];
	}
	if (sectionId === "members") {
		return [workspaceCrumb, sectionCrumb("members"), { label: <MemberName membershipId={item} /> }];
	}
	if (sectionId === "providers") {
		return [workspaceCrumb, sectionCrumb("providers"), { label: <ProviderPageName id={item} /> }];
	}
	return [workspaceCrumb, { label: workspaceSettingSection(sectionId)?.label ?? sectionId }];
}

/** A project's part of the trail: its settings, then the page. */
function projectCrumbs(project: Project, page: string | undefined): Crumb[] {
	const projectCrumb = {
		label: `${project.name} settings`,
		link: <Link {...projectSettingsLink(project)} />,
	};
	const label = projectSettingsPages.find((one) => one.id === (page ?? "general"))?.label;
	return [projectCrumb, { label: label ?? page }];
}

/** A bot's part of the trail: its settings, then the page. */
function botCrumbs(bot: Bot, page: string | undefined): Crumb[] {
	const trail: Crumb[] = [
		workspaceCrumb,
		sectionCrumb("bots"),
		{
			label: bot.name,
			link: page === undefined ? undefined : <Link {...botSettingsLink(bot)} />,
		},
	];
	const shown = botSettingsPage(page ?? "");
	if (!shown || shown === "general") return trail;
	const pageLabel = botSettingsPages.find((one) => one.id === shown)?.label ?? shown;
	return [...trail, { label: pageLabel }];
}

function MemberName({ membershipId }: { membershipId: string }) {
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	return members?.find((member) => member.id === membershipId)?.user.name ?? null;
}

/** The provider an address names, or one of the two model choices kept beside them. */
function ProviderPageName({ id }: { id: string }) {
	const { data: providers } = useModelProviders();
	if (id === "default") return "Default for new bots";
	if (id === "system") return "Summaries";
	return providers?.find((provider) => provider.id === id)?.name ?? null;
}

/** The address below the workspace, since section paths are written from inside it. */
function useSettingsPath(): string {
	const workspacePath = useMatch({ from: "/$workspace", select: (match) => match.pathname });
	return useLocation({ select: (location) => location.pathname.slice(workspacePath.length) });
}

/** Which of `project`'s pages the address is on. */
function projectPageAt(pathname: string, project: Project) {
	const [, section, slug, page] = pathname.split("/").filter(Boolean);
	if (section !== "projects" || slug !== project.slug) return undefined;
	if (page === undefined) return "general";
	return projectSettingsPage(page);
}

/** `/settings` is General, so it matches itself alone; the rest stay selected while you are inside one of their pages. */
function isSelected(section: SettingSection, pathname: string): boolean {
	if (section.id === "general") return pathname === "/settings" || pathname === "/settings/general";
	return pathname === section.path || pathname.startsWith(`${section.path}/`);
}

function SectionLink({
	section,
	selected,
	count,
}: {
	section: SettingSection;
	selected: boolean;
	count: number | undefined;
}) {
	const className = cn(NAVIGATION_ITEM, navigationItemState(selected));
	const content = <NavigationItemContent label={section.label} count={count} />;
	// Nothing separates the label from the count on screen but a gap, which a
	// name taken from the contents does not hear: "People4".
	const label = count === undefined ? undefined : `${section.label}, ${count}`;
	return section.id === "general" ? (
		<Link
			from="/$workspace"
			to="./settings"
			activeOptions={{ exact: true }}
			aria-label={label}
			aria-current={selected ? "page" : undefined}
			className={className}
		>
			{content}
		</Link>
	) : (
		<Link
			from="/$workspace"
			to="./settings/$section"
			params={{ section: section.id }}
			aria-label={label}
			aria-current={selected ? "page" : undefined}
			className={className}
		>
			{content}
		</Link>
	);
}
