import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { CatchBoundary, Link, Navigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, X } from "lucide-react";
import {
	cloneElement,
	Fragment,
	type MouseEventHandler,
	type ReactElement,
	type ReactNode,
	type RefObject,
	Suspense,
	useId,
	useRef,
} from "react";
import { useBots } from "@/lib/bots.ts";
import {
	botSettingsLink,
	closeSettingsLink,
	projectSettingsLink,
	settingsLink,
	settingsSectionLink,
} from "@/lib/links.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import {
	type ModelChoice,
	type SettingsLocation,
	sectionOf,
	settingsSearchValue,
	useCloseSettings,
} from "@/lib/open-settings.ts";
import { LIST_MIN_WIDTH_PX, usePaneWidth } from "@/lib/pane-width.ts";
import { useProjects } from "@/lib/projects.ts";
import { useSession } from "@/lib/session.ts";
import { useMemberships, useWorkspace, useWorkspacePermissions } from "@/lib/workspace.ts";
import {
	type SettingSection,
	workspaceSettingSection,
	workspaceSettingSections,
	yourSettingSections,
} from "@/lib/workspace-settings.ts";
import { lazyNamed } from "@/routes/lazy-screen.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { PageFailure } from "@/shell/PageFailure.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { isPlainClick, useBackToLinkedPage } from "@/ui/back-button.tsx";
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

const WorkspaceSettings = lazyNamed(
	() => import("@/screens/WorkspaceSettings.tsx"),
	"WorkspaceSettings",
);

/**
 * Settings, from a tablet up as a dialog over the page they were opened on,
 * which stays as it was beneath them: your own and the workspace's sections
 * down the left, the open page beside them under a trail of where it sits.
 * A bot's and a project's settings are its own pages, beside its chats.
 * Below a laptop's width there is no room for both, so settings drill down
 * as a phone's do: the sections as one list, and each opening with a way
 * back to it. On a phone they are pages over the page, which stays as it was
 * beneath them, as it does beneath the dialog.
 *
 * The frame is deliberately NOT part of the settings bundle. The sections
 * behind it are a chunk of their own, and while it is on its way the click has
 * to land on something: the navigation is there to choose from, and the
 * section fills in beside it.
 */
export function SettingsLayout({
	page,
	dialog,
}: {
	page: SettingsLocation;
	dialog?: {
		container: RefObject<HTMLDivElement | null>;
		finalFocus: RefObject<HTMLElement | null>;
	};
}) {
	const close = useCloseSettings();
	const popup = useRef<HTMLDivElement>(null);
	const index = page.kind === "sections";
	if (index && !dialog) return <Navigate from="/$workspace" to="./you" replace />;
	const frame = (
		<div className="group/settings flex min-h-0 min-w-0 flex-1 outline-none md:relative md:h-full md:w-full md:overflow-hidden md:rounded-xl md:border md:border-border-strong md:bg-background md:shadow-dialog">
			{dialog && <SettingsClose close={close} />}
			<SettingsNavigation page={page} />
			{index && <CompactSettingsList />}
			<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", index && "max-lg:hidden")}>
				<SettingsTrail page={page} />
				{/*
				 * The scrollbar's room is kept whether or not the page is long enough
				 * to need one, so a long page, such as Usage, centres its column where
				 * a short one does.
				 */}
				<main
					data-scroll-restoration-id="settings"
					className="tab-bar-clearance relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background scrollbar-gutter-stable max-md:scrollbar-gutter-auto"
				>
					{!index && <CompactPageBackBar page={page} phone={!dialog} />}
					{/*
					 * A page that fails to load fails inside the dialog, which still
					 * closes, rather than taking the page beneath with it.
					 */}
					<CatchBoundary getResetKey={() => settingsSearchValue(page)} errorComponent={PageFailure}>
						{/*
						 * Nothing rather than a skeleton: the navigation has already answered
						 * the click, and a shape that flashes beside it reads as a fault.
						 */}
						<Suspense fallback={null}>
							<WorkspaceSettings page={index ? { kind: "section", section: "general" } : page} />
						</Suspense>
					</CatchBoundary>
				</main>
			</div>
		</div>
	);
	// The shell's column holds the page beneath, so this covers it there, and the tabs stay over it.
	if (!dialog) return <div className="absolute inset-0 z-10 flex bg-background">{frame}</div>;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogPrimitive.Portal container={dialog.container}>
				<div className="fixed inset-0 z-50 flex items-center justify-center p-10">
					<DialogPrimitive.Backdrop className="absolute inset-0 bg-scrim" />
					<DialogPrimitive.Popup
						aria-label="Settings"
						ref={popup}
						initialFocus={popup}
						finalFocus={dialog.finalFocus}
						render={frame}
					/>
				</div>
			</DialogPrimitive.Portal>
		</Dialog>
	);
}

function SettingsClose({ close }: { close: () => void }) {
	const to = (
		<Link
			{...closeSettingsLink()}
			onClick={(event) => {
				// A click that opens a new tab or window follows the address instead.
				if (!isPlainClick(event)) return;
				event.preventDefault();
				close();
			}}
		/>
	);
	return (
		<IconButton
			label="Close settings"
			render={to}
			className="absolute top-2.5 right-3 z-10 hidden md:inline-grid"
		>
			<X aria-hidden />
		</IconButton>
	);
}

function CompactPageBackBar({ page, phone }: { page: SettingsLocation; phone: boolean }) {
	const goToParent = useBackToLinkedPage();
	const parent = phone
		? phoneParentPage(page)
		: (parentSection(page, goToParent) ?? {
				label: "Settings",
				render: <Link {...settingsLink()} onClick={goToParent} />,
			});
	return (
		<CompactBackBar
			{...parent}
			className="group-has-[[data-page-back]]/settings:hidden lg:hidden"
		/>
	);
}

function parentSection(
	page: SettingsLocation,
	onClick?: MouseEventHandler<HTMLAnchorElement>,
): BackTarget | undefined {
	if (page.kind === "sections" || page.kind === "section") return undefined;
	const section = workspaceSettingSection(page.kind === "member" ? "members" : "providers");
	if (!section) return undefined;
	return {
		label: section.label,
		render: (
			<Link
				{...settingsSectionLink(section.id)}
				aria-label={`Back to ${section.label}`}
				onClick={onClick}
			/>
		),
	};
}

/**
 * The page `page` sits under on a phone, whose settings are listed in its
 * You tab: Notifications under your account, a section under the page the
 * settings were opened over, and what sits under a section under it.
 */
function phoneParentPage(page: SettingsLocation): BackTarget {
	// Opened from a row on your account.
	if (page.kind === "section" && page.section === "notifications") {
		return { label: "You", render: <Link {...settingsSectionLink("account")} /> };
	}
	return parentSection(page) ?? { label: "Back", render: <Link {...closeSettingsLink()} /> };
}

/** The workspace's sections the viewer may open, with what each holds. */
function useWorkspaceSections() {
	const may = useWorkspacePermissions();
	const { workspace } = useWorkspace();
	const { data: memberships } = useMemberships(workspace?.id);
	// The one member a workspace always has is you, so the roster starts at two.
	const members = memberships?.length;
	const counts: Partial<Record<SettingSection["id"], number | undefined>> = {
		members: members === 1 ? undefined : members,
	};
	const sections = workspaceSettingSections.filter(
		(section: SettingSection) => !("needs" in section) || may[section.needs],
	);
	return { sections, counts };
}

/** The projects you are in and the bots you reach, as a phone's list of settings has them. */
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

function SettingsNavigation({ page }: { page: SettingsLocation }) {
	const { sections, counts } = useWorkspaceSections();
	const session = useSession();
	const navigation = useRef<HTMLElement>(null);
	const [width, setWidth] = usePaneWidth("settings-navigation");

	return (
		<nav
			ref={navigation}
			aria-label="Settings"
			// At its narrowest until dragged wider, and no wider than a third of the window.
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
				{session.member && (
					<NavigationGroup label="You">
						{yourSettingSections.map((section) => (
							<SectionLink
								key={section.id}
								section={section}
								selected={isSelected(section, page)}
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
							selected={isSelected(section, page)}
							count={counts[section.id]}
						/>
					))}
				</NavigationGroup>
			</div>
		</nav>
	);
}

function NavigationGroup({ label, children }: { label: string; children: ReactNode }) {
	const headingId = useId();
	return (
		// Named by its heading, so the General under You is told apart from the workspace's.
		// biome-ignore lint/a11y/useSemanticElements: this groups links, not form controls, so a fieldset is wrong.
		<div role="group" aria-labelledby={headingId} className="flex flex-col gap-px">
			{/* A sidebar row's height, so the first heading lines up with the sidebar's first row across from it. */}
			<div className="flex h-8 items-center gap-2 pr-1.5 pl-2">
				<h2 id={headingId} className="m-0 flex-1 font-medium text-subtle-foreground text-xs">
					{label}
				</h2>
			</div>
			{children}
		</div>
	);
}

/** What sits at a line's right: a count. One width for all, centred in it, so they line up down the navigation. */
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
 * projects and its bots. A phone's You tab lists them too. A project's and a
 * bot's settings are their own pages, with Back of their own.
 */
export function SettingsListGroups() {
	const { sections, counts } = useWorkspaceSections();
	const { projects, bots } = useListed();
	const { member: signedIn } = useSession();
	return (
		<>
			{/* You first, on a card that opens your account, which leads on to your Notifications. */}
			{signedIn && (
				<Link
					{...settingsSectionLink("account")}
					className={cn(
						SETTINGS_CARD,
						"focus-ring flex shrink-0 items-center gap-4 px-4 py-4 active:bg-row-selected",
					)}
				>
					<MemberAvatar member={signedIn} size={64} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate font-semibold text-xl text-foreground">{signedIn.name}</span>
						<span className="truncate text-sm text-subtle-foreground">
							Account and notifications
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
						render={<Link {...settingsSectionLink(section.id)} />}
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
							render={<Link {...projectSettingsLink(project)} />}
						/>
					))}
				</SettingsGroup>
			)}
			{bots.length > 0 && (
				<SettingsGroup label="Bots" headingLevel={2}>
					{bots.map((bot) => (
						<SettingsRow
							key={bot.id}
							icon={<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={20} />}
							label={bot.name}
							chevron
							render={<Link {...botSettingsLink(bot)} />}
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
function SettingsTrail({ page }: { page: SettingsLocation }) {
	const crumbs = settingsCrumbs(page);
	return (
		<nav
			aria-label="Breadcrumb"
			className="flex h-13 shrink-0 items-center border-border border-b pr-14 pl-6 max-lg:hidden"
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
	link: <Link {...settingsLink()} />,
};

function sectionCrumb(id: SettingSection["id"]): Crumb {
	const section = workspaceSettingSection(id);
	return { label: section?.label ?? id, link: <Link {...settingsSectionLink(id)} /> };
}

/** The trail to `page`. */
function settingsCrumbs(page: SettingsLocation): Crumb[] {
	switch (page.kind) {
		case "sections":
			return [workspaceCrumb, { label: "General" }];
		case "member":
			return [
				workspaceCrumb,
				sectionCrumb("members"),
				{ label: <MemberName membershipId={page.membership} /> },
			];
		case "provider":
			return [
				workspaceCrumb,
				sectionCrumb("providers"),
				{ label: <ProviderPageName id={page.provider} /> },
			];
		case "model":
			return [
				workspaceCrumb,
				sectionCrumb("providers"),
				{ label: MODEL_CHOICE_NAMES[page.choice] },
			];
		case "section": {
			const yours = yourSettingSections.find((section) => section.id === page.section);
			if (yours) return [{ label: "Your settings" }, { label: yours.label }];
			return [
				workspaceCrumb,
				{ label: workspaceSettingSection(page.section)?.label ?? page.section },
			];
		}
	}
}

function MemberName({ membershipId }: { membershipId: string }) {
	const { workspace } = useWorkspace();
	const { data: memberships } = useMemberships(workspace?.id);
	return memberships?.find((membership) => membership.id === membershipId)?.member.name ?? null;
}

/** What the two models kept beside the providers are called. */
const MODEL_CHOICE_NAMES: Record<ModelChoice, string> = {
	default: "Default for new bots",
	system: "Default for system bots",
};

/** The provider an address names. */
function ProviderPageName({ id }: { id: string }) {
	const { data: providers } = useModelProviders();
	return providers?.find((provider) => provider.id === id)?.name ?? null;
}

/** The list of sections opens General, so General is selected on either; the rest stay selected while one of their pages is open. */
function isSelected(section: SettingSection, page: SettingsLocation): boolean {
	if (page.kind === "sections") return section.id === "general";
	return sectionOf(page) === section.id;
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
	// name taken from the contents does not hear: "Members4".
	const label = count === undefined ? undefined : `${section.label}, ${count}`;
	return (
		<Link
			// General is the list's own page, which a laptop opens beside it.
			{...(section.id === "general" ? settingsLink() : settingsSectionLink(section.id))}
			// From one section to another in place, so Back from any of them closes settings.
			replace
			aria-label={label}
			aria-current={selected ? "page" : undefined}
			className={className}
		>
			{content}
		</Link>
	);
}
