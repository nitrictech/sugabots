import type { Pod } from "@sugabots/contracts";
import {
	type HistoryState,
	Link,
	Navigate,
	useLocation,
	useMatch,
	useNavigate,
} from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Plus } from "lucide-react";
import {
	cloneElement,
	Fragment,
	type ReactElement,
	type ReactNode,
	Suspense,
	useId,
	useRef,
	useState,
} from "react";
import { useAgents, usePodAgent } from "@/lib/agents.ts";
import { useConnections } from "@/lib/connections.ts";
import { podSettingsLink, podSettingsPageLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import { LIST_MIN_WIDTH_PX, usePaneWidth } from "@/lib/pane-width.ts";
import { findPod, usePodMembers, usePods } from "@/lib/pods.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useSession } from "@/lib/session.ts";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaceMembers, useWorkspacePermissions } from "@/lib/workspace.ts";
import {
	podSettingsPage,
	podSettingsPages,
	podSettingsPagesOf,
	type SettingSection,
	workspaceSettingSection,
	workspaceSettingSections,
	yourSettingSections,
} from "@/lib/workspace-settings.ts";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import {
	type BackTarget,
	CompactBackBar,
	SettingsGroup,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * Settings, as a page of the app beside the sidebar: the workspace's sections
 * and each pod's pages down the left, the open page beside them under a trail
 * of where it sits. Below a laptop's width there is no room for both, so
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
	const { data: pods } = usePods();
	// A phone lists settings in its You tab.
	if (index && phone) return <Navigate from="/$workspace" to="./you" replace />;
	return (
		// A group, so the frame's Back can stand aside for one the page draws itself.
		<div className="group/settings flex min-h-0 min-w-0 flex-1">
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
					className="tab-bar-clearance relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background [scrollbar-gutter:stable] max-md:[scrollbar-gutter:auto]"
				>
					{!index && (
						<CompactPageBackBar
							parent={phone ? phoneParentPage(pathname, pods) : parentPage(pathname)}
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
	);
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
	const [, sectionId, item, page, detail] = pathname.split("/").filter(Boolean);
	if (sectionId === "pods" && item !== undefined && detail !== undefined) {
		const podPage = page === "agents" ? "bots" : "connections";
		return {
			label: podPage === "bots" ? "Bots" : "Connections",
			render: (
				<Link
					from="/$workspace"
					to="./settings/pods/$pod/$page"
					params={{ pod: item, page: podPage }}
				/>
			),
		};
	}
	if (sectionId !== undefined && sectionId !== "pods" && item !== undefined) {
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
 * You tab: a pod's own pages sit under the pod's page there, Notifications
 * under your profile, and what would sit under the list of settings under the tab.
 */
function phoneParentPage(pathname: string, pods: readonly Pod[] | undefined): BackTarget {
	const [, sectionId, item, , detail] = pathname.split("/").filter(Boolean);
	if (sectionId === "pods" && item !== undefined && detail === undefined) {
		return {
			label: findPod(pods, item)?.name ?? "Pod",
			render: <Link from="/$workspace" to="./you/pods/$pod" params={{ pod: item }} />,
		};
	}
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

/** The pods you are in, shared ones first and yours apart, as the navigation lists them. */
function useListedPods() {
	const { data: pods } = usePods();
	return {
		shared: pods?.filter((pod) => pod.kind === "shared") ?? [],
		personal: pods?.filter((pod) => pod.kind === "personal") ?? [],
	};
}

/** How wide the navigation can be dragged: a third of the window, so the page beside it keeps its room. */
const NAVIGATION_MAX_WIDTH = "33vw";

function SettingsNavigation() {
	const { sections, counts } = useWorkspaceSections();
	const { shared, personal } = useListedPods();
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
				{(shared.length > 0 || may.createPods) && (
					<NavigationGroup label="Pods" action={may.createPods && <NewPodButton />}>
						{shared.map((pod) => (
							<PodNavigation key={pod.id} pod={pod} pathname={pathname} />
						))}
					</NavigationGroup>
				)}
				{personal.length > 0 && (
					<NavigationGroup label="Personal pods">
						{personal.map((pod) => (
							<PodNavigation key={pod.id} pod={pod} pathname={pathname} />
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
 * What sits at a line's right: a count, a pod's chevron, the + beside Pods.
 * One width for all, centred in it, so they line up down the navigation.
 */
const TRAILING_SLOT = "grid w-[22px] shrink-0 place-items-center";

/** One line of the navigation, picked out when it is the open page. */
const NAVIGATION_ITEM =
	"focus-ring flex h-8 min-w-0 items-center rounded-[6px] pr-1.5 pl-2 text-[14px] transition-colors";

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
 * A pod in the navigation, opening onto its pages. The pod you are in stays
 * open; the others open and close as you choose.
 */
function PodNavigation({ pod, pathname }: { pod: Pod; pathname: string }) {
	const openPage = podPageAt(pathname, pod);
	const [chosenOpen, setChosenOpen] = useRememberedOpen(pod.id);
	// Opened or closed as last chosen on this device; until then, open while you are on one of its pages.
	const open = chosenOpen ?? openPage !== undefined;
	const counts = usePodCounts(pod, open);
	const computers = useSandboxAccess().data?.enabled === true;
	const listId = `settings-pod-${pod.id}`;
	return (
		<div className="flex flex-col gap-px">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setChosenOpen(!open)}
				className={cn(
					"focus-ring flex h-8 items-center gap-2.5 rounded-[6px] pr-1.5 pl-2 text-left text-[14px] transition-colors hover:bg-row-hover hover:text-foreground",
					openPage ? "text-foreground" : "text-muted-foreground",
				)}
			>
				<PodInitial pod={pod} size="sm" />
				<span className="min-w-0 flex-1 truncate">{pod.name}</span>
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
					{podSettingsPagesOf(pod, computers).map((page) => {
						const selected = openPage === page.id;
						const className = cn(NAVIGATION_ITEM, navigationItemState(selected));
						const count = counts[page.id];
						const current = selected ? "page" : undefined;
						const label = count === undefined ? undefined : `${page.label}, ${count}`;
						return (
							<Link
								key={page.id}
								{...podSettingsPageLink(pod, page.id)}
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

const OPEN_PODS_KEY = "sugabots-settings-open-pods";

/**
 * Whether `podId` was last opened or closed in the navigation on this device,
 * and the way to choose: undefined until somebody does. Kept in the browser,
 * like a pane's width, so it survives leaving settings and reloading.
 */
function useRememberedOpen(podId: string): [boolean | undefined, (open: boolean) => void] {
	const [chosen, setChosen] = useState(() => storedOpenPods()[podId]);
	const choose = (open: boolean) => {
		setChosen(open);
		try {
			localStorage.setItem(OPEN_PODS_KEY, JSON.stringify({ ...storedOpenPods(), [podId]: open }));
		} catch {
			// Storage can be off. The choice still holds until the page is left.
		}
	};
	return [chosen, choose];
}

function storedOpenPods(): Record<string, boolean> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(OPEN_PODS_KEY) ?? "{}");
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

/** What each of a pod's pages holds, counted once the pod is open in the navigation. */
export function usePodCounts(pod: Pod, open: boolean): Partial<Record<string, number>> {
	const { agents } = useAgents();
	const connections = useConnections(open ? pod.id : undefined);
	// Only you are ever in a personal pod, so there is nobody to count.
	const members = usePodMembers(open && pod.kind === "shared" ? pod.id : undefined);
	const bots = agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null);
	return {
		connections: connections.data?.length || undefined,
		people: members.data?.length || undefined,
		bots: bots?.length || undefined,
	};
}

/** Makes a pod and opens its settings: the + beside Pods in the navigation. */
function NewPodButton() {
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	return (
		<>
			<Tooltip label="New pod">
				<button
					type="button"
					aria-label="New pod"
					onClick={() => setCreating(true)}
					className={cn(
						TRAILING_SLOT,
						"focus-ring h-[22px] rounded-[5px] text-subtle-foreground transition-colors hover:bg-row-hover hover:text-foreground",
					)}
				>
					<Plus size={13} strokeWidth={2} />
				</button>
			</Tooltip>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewPodDialog
					onCreated={async (pod) => {
						setCreating(false);
						await navigate(podSettingsLink(pod));
					}}
				/>
			</Dialog>
		</>
	);
}

/**
 * Settings on a phone or tablet: one list, as a phone's own settings are, with
 * you at the top and every section a row that opens it full screen.
 */
function CompactSettingsList() {
	return (
		<nav
			aria-label="Settings sections"
			className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto bg-background px-4 pt-4 pb-8 *:mx-auto *:w-full *:max-w-[620px] *:shrink-0 md:px-8 md:pt-9 lg:hidden"
		>
			<div className="flex items-center">
				<h1 className="m-0 flex-1 font-semibold text-[28px] text-foreground tracking-[-0.025em]">
					Settings
				</h1>
				<Link
					from="/$workspace"
					to="./agents"
					className="focus-ring rounded-md font-semibold text-[15px] text-link"
				>
					Done
				</Link>
			</div>
			<SettingsListGroups />
		</nav>
	);
}

/**
 * The groups of the list of settings: you, the workspace's sections, and its
 * pods. A phone's You tab lists them too, with `linkState` saying where each
 * page's Back returns, its pods opening `podLink` rather than their General,
 * and `you` in place of your own rows.
 */
export function SettingsListGroups({
	linkState,
	podLink = (pod) => <Link {...podSettingsLink(pod)} />,
	you,
}: {
	linkState?: (state: HistoryState) => HistoryState;
	podLink?: (pod: Pod) => ReactElement;
	you?: ReactNode;
}) {
	const { sections, counts } = useWorkspaceSections();
	const { shared, personal } = useListedPods();
	const session = useSession();
	return (
		<>
			{you}
			{!you && session.user && (
				<SettingsGroup>
					<SettingsRow
						icon={<PersonAvatar person={session.user} size={36} />}
						label={session.user.name}
						sub={session.user.email}
						chevron
						render={
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "profile" }}
								state={linkState}
							/>
						}
					/>
					<SettingsRow
						label="Notifications"
						chevron
						render={
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "notifications" }}
								state={linkState}
							/>
						}
					/>
				</SettingsGroup>
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
			{[
				{ label: "Pods", pods: shared },
				{ label: "Personal pods", pods: personal },
			].map(
				(group) =>
					group.pods.length > 0 && (
						<SettingsGroup key={group.label} label={group.label} headingLevel={2}>
							{group.pods.map((pod) => (
								<SettingsRow
									key={pod.id}
									icon={<PodInitial pod={pod} size="sm" />}
									label={pod.name}
									chevron
									render={podLink(pod)}
								/>
							))}
						</SettingsGroup>
					),
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
			className={cn(
				"flex h-[52px] shrink-0 items-center justify-center border-border border-b px-[72px]",
				className,
			)}
		>
			<ol className="m-0 flex min-w-0 list-none items-center gap-2.5 p-0 text-[13px]">
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
	const { data: pods } = usePods();
	const [, sectionId, item, page, detail] = pathname.split("/").filter(Boolean);
	if (sectionId === undefined || sectionId === "general") {
		return [workspaceCrumb, { label: "General" }];
	}
	const yours = yourSettingSections.find((section) => section.id === sectionId);
	if (yours) {
		return [{ label: "Your settings" }, { label: yours.label }];
	}
	if (sectionId === "pods" && item !== undefined) {
		const pod = findPod(pods, item);
		return pod ? podCrumbs(pod, page, detail) : [];
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

/** A pod's part of the trail: its settings, then the page, then what is open on it. */
function podCrumbs(pod: Pod, page: string | undefined, detail: string | undefined): Crumb[] {
	const podCrumb = { label: `${pod.name} settings`, link: <Link {...podSettingsLink(pod)} /> };
	if (page === "agents" && detail !== undefined) {
		return [
			podCrumb,
			{ label: "Bots", link: <Link {...podSettingsPageLink(pod, "bots")} /> },
			{ label: <BotName podSlug={pod.slug} handle={detail} /> },
		];
	}
	if (page === "connections" && detail !== undefined) {
		return [
			podCrumb,
			{ label: "Connections", link: <Link {...podSettingsPageLink(pod, "connections")} /> },
			{ label: <ConnectionName podId={pod.id} connectionId={detail} /> },
		];
	}
	const label = podSettingsPages.find((one) => one.id === (page ?? "general"))?.label;
	return [podCrumb, { label: label ?? page }];
}

function BotName({ podSlug, handle }: { podSlug: string; handle: string }) {
	return usePodAgent(podSlug, handle).found?.agent.name ?? null;
}

function ConnectionName({ podId, connectionId }: { podId: string; connectionId: string }) {
	return useConnections(podId).data?.find((one) => one.id === connectionId)?.name ?? null;
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

/** Which of `pod`'s pages the address is on, counting what opens inside one as that page. */
function podPageAt(pathname: string, pod: Pod) {
	const [, section, slug, page] = pathname.split("/").filter(Boolean);
	if (section !== "pods" || slug !== pod.slug) return undefined;
	if (page === undefined) return "general";
	if (page === "agents") return "bots";
	return podSettingsPage(page);
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
