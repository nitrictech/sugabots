import { type SystemAgentKey, type WorkspaceRole, workspaceRoleLabel } from "@sugabots/contracts";
import { Link, useRouteContext } from "@tanstack/react-router";
import { Building2, Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { usePods } from "@/lib/pods.ts";
import {
	chooseWorkspace,
	useWorkspace,
	useWorkspacePermissions,
	useWorkspaceRole,
	useWorkspaces,
} from "@/lib/workspace.ts";
import { type WorkspaceSettingSection, workspaceSettingSection } from "@/lib/workspace-settings.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import { SurfaceColumn, SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";
import { BuiltInAgentsSettings } from "./BuiltInAgentsSettings.tsx";
import { ModelProvidersSettings } from "./ModelProvidersSettings.tsx";
import { WebSearchSettings } from "./WebSearchSettings.tsx";
import { WorkspaceAgentsSettings } from "./WorkspaceAgentsSettings.tsx";
import { WorkspaceMembersSettings } from "./WorkspaceMembersSettings.tsx";
import { WorkspacePodsSettings } from "./WorkspacePodsSettings.tsx";

export function WorkspaceSettings({
	section,
	selectedAgentId,
	selectedPodId,
	selectedAgentTab,
	selectedBuiltInKey,
}: {
	section: WorkspaceSettingSection;
	selectedAgentId?: string;
	selectedPodId?: string;
	selectedAgentTab?: "routines";
	selectedBuiltInKey?: SystemAgentKey;
}) {
	const { workspace, isPending } = useWorkspace();
	const { session } = useRouteContext({ from: "__root__" });
	const may = useWorkspacePermissions();
	const role = useWorkspaceRole();
	const { data: pods } = usePods();

	const sectionLabel = workspaceSettingSection(section)?.label;
	// The dialog's own header names the workspace, and each detail screen names
	// itself, so a section only has to say which one it is — and only where
	// nothing under it already does. A split view's rail is that heading.
	//
	// An agent's page is the exception: it names the agent, and the pod it is
	// being configured in is named nowhere else on it.
	const selectedPod = selectedAgentId ? pods?.find((pod) => pod.id === selectedPodId) : undefined;
	if (isPending) return null;
	if (!workspace) return <FirstWorkspace />;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{selectedPod && (
				<SurfaceHeader density="compact">
					<SurfaceTitle
						size="sm"
						title={
							<nav aria-label="Breadcrumb" className="flex items-center gap-2.5">
								<Link
									to="/settings/$section"
									params={{ section: "pods" }}
									className="font-normal text-muted-foreground hover:text-heading"
								>
									{sectionLabel}
								</Link>
								<ChevronRight size={17} className="shrink-0 text-muted-foreground" />
								<h2 className="m-0 truncate font-normal text-muted-foreground text-lg">
									{selectedPod.name}
								</h2>
							</nav>
						}
					/>
				</SurfaceHeader>
			)}
			{section === "providers" && may.manageProviders ? (
				<ModelProvidersSettings />
			) : section === "agents" ? (
				<WorkspaceAgentsSettings selectedAgentId={selectedAgentId} />
			) : section === "pods" ? (
				<WorkspacePodsSettings
					selectedPodId={selectedPodId}
					selectedAgentId={selectedAgentId}
					selectedAgentTab={selectedAgentTab}
					canCreatePods={may.createPods}
				/>
			) : section === "built-in-agents" && may.configureBuiltInAgents ? (
				<BuiltInAgentsSettings selectedKey={selectedBuiltInKey} />
			) : (
				<ScrollArea className="relative min-h-0 flex-1">
					<SurfaceColumn className="flex max-w-[1000px] flex-col gap-8 px-4 py-7 md:px-7 md:py-8">
						<h2 className="m-0 font-semibold text-3xl text-heading">{sectionLabel}</h2>
						{section === "general" && <GeneralSettings role={role} />}
						{section === "members" && (
							<WorkspaceMembersSettings
								workspaceId={workspace.id}
								canManage={may.manageMembers}
								currentUserId={session.user?.id}
							/>
						)}
						{section === "providers" && (
							<Alert>Only workspace administrators can manage model providers.</Alert>
						)}
						{section === "search" && may.manageProviders && <WebSearchSettings />}
						{section === "search" && !may.manageProviders && (
							<Alert>Only workspace administrators can manage web search.</Alert>
						)}
						{section === "built-in-agents" && (
							<Alert>Only workspace administrators can configure the built-in agents.</Alert>
						)}
					</SurfaceColumn>
				</ScrollArea>
			)}
		</div>
	);
}

function FirstWorkspace() {
	return (
		<ScrollArea className="min-h-0 flex-1">
			<SurfaceColumn className="flex max-w-[900px] flex-col gap-8 px-4 py-7 md:px-7 md:py-9">
				<h2 className="m-0 font-semibold text-3xl text-heading">Workspaces</h2>
				<SettingsBlock title="No workspace selected">
					<WorkspaceList />
				</SettingsBlock>
			</SurfaceColumn>
		</ScrollArea>
	);
}

function GeneralSettings({ role }: { role: WorkspaceRole | undefined }) {
	const { workspace } = useWorkspace();
	if (!workspace) return null;

	return (
		<div className="flex flex-col gap-10">
			<SettingsBlock title="Workspace">
				<dl className="overflow-hidden rounded-xl border border-border-subtle">
					<SettingValue label="Name">{workspace.name}</SettingValue>
					<SettingValue label="Your access">{workspaceRoleLabel(role)}</SettingValue>
				</dl>
			</SettingsBlock>
			<SettingsBlock title="Your workspaces">
				<WorkspaceList />
			</SettingsBlock>
		</div>
	);
}

function SettingsBlock({
	title,
	action,
	children,
}: {
	title: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-4">
				<h3 className="m-0 font-semibold text-heading text-xl">{title}</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

function SettingValue({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-h-14 grid-cols-[minmax(7rem,0.35fr)_1fr] items-center gap-4 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
			<dt className="font-medium text-muted-foreground text-sm">{label}</dt>
			<dd className="min-w-0 truncate text-foreground">{children}</dd>
		</div>
	);
}

function WorkspaceList() {
	const { data: workspaces } = useWorkspaces();
	const { workspace } = useWorkspace();
	return (
		<div className="flex flex-col gap-3">
			<ul className="overflow-hidden rounded-xl border border-border-subtle">
				{workspaces?.map((one) => (
					<li
						key={one.id}
						className="flex min-h-14 items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0"
					>
						<Building2 size={17} className="shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1 truncate font-medium text-heading">{one.name}</span>
						{one.id === workspace?.id ? (
							<span className="flex items-center gap-1.5 text-md text-primary">
								<Check size={14} /> Current
							</span>
						) : (
							<Button variant="link" size="bare" onClick={() => chooseWorkspace(one.id)}>
								Switch
							</Button>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
