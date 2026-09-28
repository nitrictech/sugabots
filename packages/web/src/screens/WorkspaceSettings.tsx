import { type WorkspaceRole, workspaceRoleLabel } from "@sugabots/contracts";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { client } from "@/api.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";
import {
	useWorkspace,
	useWorkspaceMembers,
	useWorkspacePermissions,
	useWorkspaceRole,
} from "@/lib/workspace.ts";
import type { WorkspaceSettingSection } from "@/lib/workspace-settings.ts";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { ModelsSettings, SystemModelSettings } from "./ModelsSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { WorkspaceRoutinesSettings } from "./RoutinesSettings.tsx";
import { WebSearchSettings } from "./WebSearchSettings.tsx";
import { WorkspaceAgentsSettings } from "./WorkspaceAgentsSettings.tsx";
import { WorkspaceMembersSettings } from "./WorkspaceMembersSettings.tsx";
import { WorkspacePodsSettings } from "./WorkspacePodsSettings.tsx";

export function WorkspaceSettings({
	section,
	selectedAgentId,
	selectedPodId,
	connectionSignInError,
	selectedAgentTab,
	selectedProviderId,
	systemModel = false,
	selectedMemberId,
}: {
	section: WorkspaceSettingSection;
	selectedAgentId?: string;
	selectedPodId?: string;
	connectionSignInError?: string;
	selectedAgentTab?: "routines";
	/** The provider open on the Models page. */
	selectedProviderId?: string;
	/** Whether the Models page shows the system bots' model instead. */
	systemModel?: boolean;
	/** The membership open on the Members page. */
	selectedMemberId?: string;
}) {
	const { workspace, isPending } = useWorkspace();
	const { session } = useRouteContext({ from: "__root__" });
	const may = useWorkspacePermissions();
	const role = useWorkspaceRole();

	// The shell sends somebody in no workspace to onboarding, so there is always one here.
	if (isPending || !workspace) return null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{section === "providers" && may.manageProviders ? (
				systemModel && may.configureBuiltInAgents ? (
					<SystemModelSettings />
				) : selectedProviderId ? (
					<ProviderSettings providerId={selectedProviderId} />
				) : (
					<ModelsSettings />
				)
			) : section === "agents" ? (
				<WorkspaceAgentsSettings
					selectedAgentId={selectedAgentId}
					selectedAgentTab={selectedAgentTab}
				/>
			) : section === "pods" ? (
				<WorkspacePodsSettings
					selectedPodId={selectedPodId}
					connectionSignInError={connectionSignInError}
					canCreatePods={may.createPods}
				/>
			) : section === "routines" ? (
				<WorkspaceRoutinesSettings workspaceId={workspace.id} />
			) : (
				<>
					{section === "general" && <GeneralSettings role={role} />}
					{section === "profile" && <ProfileSettings />}
					{section === "members" && (
						<WorkspaceMembersSettings
							workspaceId={workspace.id}
							canManage={may.manageMembers}
							currentUserId={session.user?.id}
							selectedMemberId={selectedMemberId}
						/>
					)}
					{section === "search" && (
						<SettingsPage title="Web search" description="How bots look things up online.">
							{may.manageProviders ? (
								<WebSearchSettings />
							) : (
								<Alert>Only workspace administrators can manage web search.</Alert>
							)}
						</SettingsPage>
					)}
					{section === "providers" && (
						<SettingsPage title="Models">
							<Alert>Only workspace administrators can manage models.</Alert>
						</SettingsPage>
					)}
				</>
			)}
		</div>
	);
}

function GeneralSettings({ role }: { role: WorkspaceRole | undefined }) {
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	if (!workspace) return null;
	const people = members?.length;

	return (
		<SettingsPage
			hero={
				<span
					aria-hidden
					className="grid size-[88px] place-items-center rounded-[26px] bg-foreground font-extrabold text-[34px] text-background"
				>
					{workspace.name.trim().charAt(0).toUpperCase()}
				</span>
			}
			title={workspace.name}
			description={
				people === undefined ? undefined : `${people} ${people === 1 ? "member" : "members"}`
			}
		>
			<SettingsGroup label="Workspace">
				<SettingsRow label="Name" trailing={<SettingsValue>{workspace.name}</SettingsValue>} />
				<SettingsRow
					label="Time zone"
					trailing={<SettingsValue>{workspace.timeZone}</SettingsValue>}
				/>
				<SettingsRow
					label="Your access"
					trailing={<SettingsValue>{workspaceRoleLabel(role)}</SettingsValue>}
				/>
			</SettingsGroup>
			<SettingsGroup label="Appearance">
				<SettingsRow label="Theme" trailing={<ThemeChoice />} />
			</SettingsGroup>
		</SettingsPage>
	);
}

const themes: readonly { value: Theme; label: string }[] = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
	{ value: "system", label: "System" },
];

function ThemeChoice() {
	const [theme, setTheme] = useTheme();
	return <SegmentedControl label="Theme" options={themes} value={theme} onChange={setTheme} />;
}

function ProfileSettings() {
	const { session } = useRouteContext({ from: "__root__" });
	const navigate = useNavigate();
	const user = session.user;
	if (!user) return null;

	async function signOut() {
		await client.auth.signOut();
		await session.refresh();
		await navigate({ to: "/login", replace: true });
	}

	return (
		<SettingsPage
			hero={<PersonAvatar name={user.name} image={user.image} size={88} />}
			title={user.name}
			description={user.email}
		>
			<SettingsGroup label="Account">
				<SettingsRow label="Name" trailing={<SettingsValue>{user.name}</SettingsValue>} />
				<SettingsRow label="Email" trailing={<SettingsValue>{user.email}</SettingsValue>} />
			</SettingsGroup>
			<SettingsDanger onClick={() => void signOut()}>Sign out</SettingsDanger>
		</SettingsPage>
	);
}
