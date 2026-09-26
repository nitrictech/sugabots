import { Link, useLocation, useMatch, useRouteContext } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft, X } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { useAgents } from "@/lib/agents.ts";
import { usePods } from "@/lib/pods.ts";
import { useWorkspaceRoutines } from "@/lib/routines.ts";
import { useWorkspace, useWorkspaceMembers, useWorkspacePermissions } from "@/lib/workspace.ts";
import { type SettingSection, workspaceSettingGroups } from "@/lib/workspace-settings.ts";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * Settings, as a page of the app beside the rail: its sections down the left,
 * grouped the way a phone's settings are, and the open one beside them. Below
 * a laptop's width there is no room for both beside a section's own list, so
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
	// A section's own page, as against a page inside one, which has its own way back.
	const atSection =
		!index &&
		workspaceSettingGroups.some((group) =>
			group.sections.some((section: SettingSection) => section.path === pathname),
		);
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<SettingsNavigation />
			{index && <CompactSettingsList />}
			<main
				className={cn(
					// A column, so a list beside its open item fills the height, and its border with it.
					"flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background",
					index && "max-lg:hidden",
				)}
			>
				{(atSection || pathname === "/settings/general") && (
					<div className="sticky top-0 z-10 flex h-12 items-center bg-background/90 px-2.5 backdrop-blur lg:hidden">
						<Link
							from="/$workspace"
							to="./settings"
							className="focus-ring inline-flex items-center gap-0.5 rounded-md font-medium text-[15px] text-link"
						>
							<ChevronLeft aria-hidden size={20} strokeWidth={2.2} />
							Settings
						</Link>
					</div>
				)}
				{/*
				 * Nothing rather than a skeleton: the navigation has already answered
				 * the click, and a shape that flashes beside it reads as a fault.
				 */}
				<Suspense fallback={null}>{children}</Suspense>
			</main>
		</div>
	);
}

/** The sections the viewer may open, grouped as the navigation lists them, with what each holds. */
function useSettingSections() {
	const may = useWorkspacePermissions();
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const { data: routines } = useWorkspaceRoutines(workspace?.id);
	// A section counts what it holds, where that is a number worth glancing at.
	// The one member a workspace always has is you, so the roster starts at two.
	const people = members?.length;
	const counts: Partial<Record<SettingSection["id"], number | undefined>> = {
		members: people === 1 ? undefined : people,
		pods: pods?.length || undefined,
		agents: agents?.filter((agent) => agent.systemAgentKey === null).length || undefined,
		// Nothing to count is no count, as a phone's settings leave it.
		routines: routines?.items.length || undefined,
	};
	const groups = workspaceSettingGroups
		.map((group) => ({
			label: group.label,
			sections: group.sections.filter(
				(section: SettingSection) => !("needs" in section) || may[section.needs],
			),
		}))
		.filter((group) => group.sections.length > 0);
	return { groups, counts };
}

function SettingsNavigation() {
	const { groups, counts } = useSettingSections();
	const { session } = useRouteContext({ from: "__root__" });
	const pathname = useSettingsPath();

	return (
		<nav
			aria-label="Settings"
			className="flex min-h-0 w-[260px] shrink-0 flex-col border-border border-r bg-list max-lg:hidden"
		>
			<div className="flex shrink-0 items-center pt-[18px] pr-3.5 pb-3.5 pl-4">
				<h1 className="m-0 flex-1 font-extrabold text-foreground text-xl tracking-[-0.02em]">
					Settings
				</h1>
				<Tooltip label="Close settings">
					<Link
						from="/$workspace"
						to="./agents"
						aria-label="Close settings"
						className="focus-ring grid size-8 shrink-0 place-items-center rounded-full bg-chip text-soft-foreground transition-colors hover:bg-hover"
					>
						<X size={15} strokeWidth={2.4} />
					</Link>
				</Tooltip>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-2 pb-3">
				{groups.map((group) => (
					<div key={group.label} className="flex flex-col gap-px">
						<h2 className="m-0 px-2.5 pb-1.5 font-medium text-subtle-foreground text-xs">
							{group.label}
						</h2>
						{group.sections.map((section) => (
							<SectionLink
								key={section.id}
								section={section}
								selected={isSelected(section, pathname)}
								count={counts[section.id]}
							/>
						))}
					</div>
				))}
			</div>
			{session.user && (
				<div className="flex shrink-0 items-center gap-2.5 border-border border-t px-[18px] pt-3 pb-[18px]">
					<PersonAvatar name={session.user.name} image={session.user.image} size={32} />
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate font-medium text-[13.5px] text-foreground">
							{session.user.name}
						</span>
						<span className="truncate text-muted-foreground text-xs">{session.user.email}</span>
					</span>
				</div>
			)}
		</nav>
	);
}

/**
 * Settings on a phone or tablet: one list, as a phone's own settings are, with
 * you at the top and every section a row that opens it full screen.
 */
function CompactSettingsList() {
	const { groups, counts } = useSettingSections();
	const { session } = useRouteContext({ from: "__root__" });
	return (
		<nav
			aria-label="Settings sections"
			className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto bg-background px-4 pt-4 pb-8 *:mx-auto *:w-full *:max-w-[620px] md:px-8 md:pt-9 lg:hidden"
		>
			<div className="flex items-center">
				<h1 className="m-0 flex-1 font-extrabold text-[30px] text-foreground tracking-[-0.02em]">
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
			{session.user && (
				<div className="overflow-hidden rounded-panel bg-list">
					<SettingsRow
						icon={<PersonAvatar name={session.user.name} image={session.user.image} size={46} />}
						label={session.user.name}
						sub={session.user.email}
						chevron
						render={
							<Link from="/$workspace" to="./settings/$section" params={{ section: "profile" }} />
						}
					/>
				</div>
			)}
			{groups.map((group) => {
				// You are the card at the top, so a group of only your profile says nothing more.
				const sections = group.sections.filter((section) => section.id !== "profile");
				if (sections.length === 0) return null;
				return (
					<SettingsGroup key={group.label} label={group.label} headingLevel={2}>
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
									/>
								}
							/>
						))}
					</SettingsGroup>
				);
			})}
		</nav>
	);
}

/** The address below the workspace, since section paths are written from inside it. */
function useSettingsPath(): string {
	const workspacePath = useMatch({ from: "/$workspace", select: (match) => match.pathname });
	return useLocation({ select: (location) => location.pathname.slice(workspacePath.length) });
}

/**
 * `/settings` is General, so it matches itself alone; the rest stay selected
 * while you are inside one of their pages. A bot's address runs through its
 * pod's, but a bot is opened from Bots, so that is what it belongs to.
 */
const BOT_PAGE = /^\/settings\/pods\/[^/]+\/agents\//;

function isSelected(section: SettingSection, pathname: string): boolean {
	if (section.id === "general") return pathname === "/settings" || pathname === "/settings/general";
	if (BOT_PAGE.test(pathname)) return section.id === "agents";
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
	const className = cn(
		"focus-ring flex min-h-10 items-center rounded-xl px-2.5 py-[9px] text-[14.5px] text-foreground transition-colors",
		selected ? "bg-chip font-semibold" : "hover:bg-row-hover",
	);
	const content = (
		<>
			<span className="min-w-0 flex-1 truncate">{section.label}</span>
			{count !== undefined && (
				<span aria-hidden="true" className="text-md text-subtle-foreground">
					{count}
				</span>
			)}
		</>
	);
	// Nothing separates the label from the count on screen but a gap, which a
	// name taken from the contents does not hear: "Pods2".
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
