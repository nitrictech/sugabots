import { Dialog } from "@base-ui/react/dialog";
import { hueFromText } from "@sugabots/contracts";
import { Link, useLocation, useMatch, useNavigate } from "@tanstack/react-router";
import { Settings, X } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { useAgents } from "@/lib/agents.ts";
import { usePods } from "@/lib/pods.ts";
import { useWorkspace, useWorkspaceMembers, useWorkspacePermissions } from "@/lib/workspace.ts";
import { workspaceSettingSections } from "@/lib/workspace-settings.ts";
import { Panes } from "@/shell/Shell.tsx";
import { DialogOverlay } from "@/ui/dialog.tsx";
import { SettingsRailItem } from "@/ui/settings-rail.tsx";
import { SurfaceGlow } from "@/ui/surface.tsx";

/**
 * Workspace settings, as a window over the app rather than a screen in it.
 *
 * Settings is somewhere you visit and leave again, so it covers the app
 * instead of replacing it: the roster stays behind the scrim, and the way out
 * is the cross in the corner rather than a link to find at the top of a list.
 * Closing lands on the workspace's agents, which is where leaving settings has
 * always landed.
 *
 * The dialog owns the section rail, because the rail belongs to the surface
 * the sections open on. While settings is open the top bar is behind the
 * scrim, so the workspace's name rides in the header: it is the one thing
 * these sections are all about, and nothing else on screen still says it.
 *
 * This frame is deliberately NOT part of the settings bundle. The sections
 * behind it are a 150 kB chunk, and while that chunk is on its way the click
 * has to land on something: the window opens, the rail is there to choose
 * from, and the section fills in under it.
 */
export function SettingsDialog({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const { workspace } = useWorkspace();
	const hue = hueFromText(workspace?.slug ?? "");

	return (
		<>
			{/*
			 * The pane the dialog covers. Settings has no pane of its own, and the
			 * frame reads as the app waiting underneath rather than as a hole in it.
			 */}
			<Panes>{null}</Panes>
			<Dialog.Root
				open
				onOpenChange={(open) => {
					if (!open) void navigate({ from: "/$workspace", to: "./agents" });
				}}
			>
				<Dialog.Portal>
					<DialogOverlay className="z-40" />
					<Dialog.Popup
						className="agent-tint fixed inset-overlay-gutter z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
						style={{ ["--agent-hue" as string]: hue }}
					>
						<SurfaceGlow hue={hue} />
						<header className="relative flex min-h-header shrink-0 items-center gap-3 border-b border-border-subtle py-3 pr-3 pl-4 md:pl-7">
							<Settings aria-hidden size={17} className="shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<Dialog.Title className="truncate font-semibold text-2xl text-heading">
									Workspace settings
								</Dialog.Title>
								{workspace && (
									<p className="truncate pt-0.5 text-base text-surface-muted-foreground">
										{workspace.name}
									</p>
								)}
							</div>
							<Dialog.Close
								aria-label="Close settings"
								className="focus-ring grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-surface-accent hover:text-heading"
							>
								<X size={20} />
							</Dialog.Close>
						</header>
						<div className="flex min-h-0 flex-1 flex-col md:flex-row">
							<SettingsSections />
							{/*
							 * Nothing rather than a skeleton: the window and its rail have
							 * already answered the click, and a shape that flashes under
							 * them reads as a fault.
							 */}
							<Suspense fallback={null}>{children}</Suspense>
						</div>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</>
	);
}

type SettingSection = (typeof workspaceSettingSections)[number];

/** The sections anybody in the workspace may open. */
const unrestrictedSections = workspaceSettingSections.filter((section) => !("needs" in section));

/**
 * The settings sections, as one list.
 *
 * Six links did not need three headings over them, and two of those headings
 * named nothing anybody looks for. What the rule near the bottom separates is
 * the only division that survives a reader: what anybody in the workspace may
 * open, and what answers to a permission. Hold none of those permissions and
 * the rule and everything under it are simply absent.
 *
 * A column beside the content where there is room for one, and a strip along
 * the top of the dialog where there is not — so every section stays one tap
 * away on a phone rather than behind a level of navigation.
 */
function SettingsSections() {
	// Section paths are written from inside the workspace, so compare what follows it.
	const workspacePath = useMatch({ from: "/$workspace", select: (match) => match.pathname });
	const pathname = useLocation({
		select: (location) => location.pathname.slice(workspacePath.length),
	});
	const may = useWorkspacePermissions();
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	const { data: pods } = usePods();
	const { agents } = useAgents();
	// A section counts what it holds, where that is a number worth glancing at.
	// The rest carry none rather than a zero that means "not counted". The one
	// member a workspace always has is you, so the roster starts counting at two.
	const people = members?.length;
	const counts: Partial<Record<SettingSection["id"], number | undefined>> = {
		members: people === 1 ? undefined : people,
		pods: pods?.length,
		agents: agents?.length,
	};
	const permittedSections = workspaceSettingSections.filter(
		(section) => "needs" in section && may[section.needs],
	);
	const link = (section: SettingSection) => (
		<SectionLink
			key={section.id}
			section={section}
			pathname={pathname}
			count={counts[section.id]}
		/>
	);

	return (
		<nav
			aria-label="Workspace settings"
			className="flex shrink-0 gap-1 overflow-x-auto border-border-subtle border-b bg-sunken p-3 md:w-rail md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-4"
		>
			{unrestrictedSections.map(link)}
			{permittedSections.length > 0 && (
				<>
					<hr className="mx-1 my-0 h-auto shrink-0 self-stretch border-border-subtle border-l md:mx-3 md:my-2 md:h-0 md:self-auto md:border-t md:border-l-0" />
					{permittedSections.map(link)}
				</>
			)}
		</nav>
	);
}

function SectionLink({
	section,
	pathname,
	count,
}: {
	section: SettingSection;
	pathname: string;
	count: number | undefined;
}) {
	const { id, path, label } = section;
	// `/settings` is the General section, so it matches itself alone; the rest
	// stay selected while you are inside one of their pages.
	const selected = pathname === path || (path !== "/settings" && pathname.startsWith(`${path}/`));

	return (
		<SettingsRailItem
			selected={selected}
			// General is the settings route itself; every other section is a
			// `$section` of it. The paths in `workspaceSettingSections` say the same
			// thing, but as strings the router cannot check.
			//
			// General matches exactly, or it would be the current page on every
			// section, all of which sit under its address.
			render={
				id === "general" ? (
					<Link from="/$workspace" to="./settings" activeOptions={{ exact: true }} />
				) : (
					<Link from="/$workspace" to="./settings/$section" params={{ section: id }} />
				)
			}
			// Nothing separates the label from the count on screen but a gap, which
			// a name taken from the contents does not hear: "Pods2". Naming the row
			// says the pair the way it is read.
			aria-label={count === undefined ? undefined : `${label}, ${count}`}
			className="min-h-10 shrink-0 gap-2 whitespace-nowrap py-2 md:w-full"
		>
			<span className="min-w-0 font-medium text-base md:flex-1">{label}</span>
			{count !== undefined && (
				<span aria-hidden="true" className="font-mono text-subtle-foreground text-xs">
					{count}
				</span>
			)}
		</SettingsRailItem>
	);
}
