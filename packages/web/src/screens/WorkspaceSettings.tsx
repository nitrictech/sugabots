import {
	type Agent,
	type Pod,
	USER_NAME_MAX_LENGTH,
	type WorkspaceRole,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { usePods } from "@/lib/pods.ts";
import { useReferralLink, useResetReferralLink } from "@/lib/referrals.ts";
import { useSession, useSignOut, useUpdateName } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { type Theme, useTheme } from "@/lib/theme.ts";
import {
	useDeleteWorkspace,
	useWorkspace,
	useWorkspaceMembers,
	useWorkspacePermissions,
	useWorkspaceRole,
	useWorkspaceTimeZone,
} from "@/lib/workspace.ts";
import type { PodSettingsPage, WorkspaceSettingSection } from "@/lib/workspace-settings.ts";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsDanger,
	SettingsGroup,
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { AgentSettingsPage } from "./AgentSettingsPage.tsx";
import { DefaultModelSettings, ModelsSettings, SystemModelSettings } from "./ModelsSettings.tsx";
import { NotificationsSettings } from "./NotificationsSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { SandboxSettings } from "./SandboxSettings.tsx";
import { TimeZoneDialog } from "./TimeZoneDialog.tsx";
import { UsageSettings } from "./UsageSettings.tsx";
import { WebSearchSettings } from "./WebSearchSettings.tsx";
import { WorkspaceMembersSettings } from "./WorkspaceMembersSettings.tsx";
import { WorkspacePodsSettings } from "./WorkspacePodsSettings.tsx";

export function WorkspaceSettings({
	section,
	selectedAgent,
	selectedPodId,
	podPage,
	selectedConnectionId,
	connectionSignInError,
	selectedProviderId,
	modelChoice,
	selectedMemberId,
}: {
	section: WorkspaceSettingSection;
	/** A bot open on its own page, in place of its pod's. */
	selectedAgent?: { agent: Agent; pod: Pod };
	selectedPodId?: string;
	/** Which of the selected pod's pages is open. */
	podPage?: PodSettingsPage;
	/** The connection of the selected pod open on its own page. */
	selectedConnectionId?: string;
	connectionSignInError?: string;
	/** The provider open on the Models page. */
	selectedProviderId?: string;
	/** Which model the Models page shows the choice of instead: new bots' or the system bots'. */
	modelChoice?: "default" | "system";
	/** The membership open on the Members page. */
	selectedMemberId?: string;
}) {
	const { workspace, isPending } = useWorkspace();
	const session = useSession();
	const may = useWorkspacePermissions();
	const role = useWorkspaceRole();

	// The shell sends somebody in no workspace to onboarding, so there is always one here.
	if (isPending || !workspace) return null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{section === "providers" && may.manageProviders ? (
				modelChoice === "system" && may.configureBuiltInAgents ? (
					<SystemModelSettings />
				) : modelChoice === "default" ? (
					<DefaultModelSettings />
				) : selectedProviderId ? (
					<ProviderSettings providerId={selectedProviderId} />
				) : (
					<ModelsSettings />
				)
			) : selectedAgent ? (
				<AgentSettingsPage
					key={selectedAgent.agent.id}
					agent={selectedAgent.agent}
					pod={selectedAgent.pod}
				/>
			) : section === "pods" ? (
				<WorkspacePodsSettings
					selectedPodId={selectedPodId}
					podPage={podPage}
					selectedConnectionId={selectedConnectionId}
					connectionSignInError={connectionSignInError}
					canCreatePods={may.createPods}
				/>
			) : (
				<>
					{section === "general" && (
						<GeneralSettings
							role={role}
							canUpdate={may.updateWorkspace}
							canDelete={may.deleteWorkspace}
						/>
					)}
					{section === "profile" && <ProfileSettings />}
					{section === "notifications" && <NotificationsSettings />}
					{section === "members" && (
						<WorkspaceMembersSettings
							workspaceId={workspace.id}
							canManage={may.manageMembers}
							canManageAdmins={may.manageAdmins}
							canTransferOwnership={may.transferOwnership}
							currentUserId={session.user?.id}
							selectedMemberId={selectedMemberId}
						/>
					)}
					{section === "search" && (
						<SettingsPage
							title="Web search"
							description="Lets bots look things up and cite the pages they used."
						>
							{may.manageProviders ? (
								<WebSearchSettings />
							) : (
								<Alert>Only workspace administrators can manage web search.</Alert>
							)}
						</SettingsPage>
					)}
					{section === "sandboxes" && (
						<SettingsPage
							title="Computers"
							description="Give bots their own computer to run commands, browse and edit files."
						>
							{may.manageProviders ? (
								<SandboxSettings />
							) : (
								<Alert>Only workspace administrators can manage computers.</Alert>
							)}
						</SettingsPage>
					)}
					{section === "usage" &&
						(may.manageUsage ? (
							<UsageSettings />
						) : (
							<SettingsPage title="Usage">
								<Alert>Only workspace administrators can see what the workspace spends.</Alert>
							</SettingsPage>
						))}
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

/** What General says the workspace holds, once both counts have loaded. */
function workspaceSummary(
	people: number | undefined,
	pods: number | undefined,
): string | undefined {
	if (people === undefined || pods === undefined) return undefined;
	const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
	return `Workspace with ${plural(people, "member")} and ${plural(pods, "pod")}`;
}

function GeneralSettings({
	role,
	canUpdate,
	canDelete,
}: {
	role: WorkspaceRole | undefined;
	canUpdate: boolean;
	canDelete: boolean;
}) {
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	const { data: pods } = usePods();
	const [choosingTimeZone, setChoosingTimeZone] = useState(false);
	// Loaded with the page, so the dialog opens with its routines note already in place.
	useWorkspaceTimeZone(workspace?.id ?? "", canUpdate && workspace !== undefined);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const deleteWorkspace = useDeleteWorkspace();
	const navigate = useNavigate();
	if (!workspace) return null;

	async function confirmDelete(workspaceId: string) {
		try {
			await deleteWorkspace.mutateAsync(workspaceId);
		} catch {
			return;
		}
		await navigate({ to: "/", replace: true });
	}

	return (
		<SettingsPage title="General" description={workspaceSummary(members?.length, pods?.length)}>
			<SettingsGroup>
				<SettingsRow label="Name" trailing={<SettingsValue>{workspace.name}</SettingsValue>} />
				<SettingsRow
					label="Time zone"
					sub="Routines run on this clock"
					trailing={<SettingsValue>{workspace.timeZone}</SettingsValue>}
					chevron={canUpdate}
					onClick={canUpdate ? () => setChoosingTimeZone(true) : undefined}
				/>
				<SettingsRow
					label="Your access"
					trailing={<SettingsValue>{workspaceRoleLabel(role)}</SettingsValue>}
				/>
			</SettingsGroup>
			{canUpdate && (
				<TimeZoneDialog
					workspaceId={workspace.id}
					current={workspace.timeZone}
					open={choosingTimeZone}
					onOpenChange={setChoosingTimeZone}
				/>
			)}
			{canDelete && (
				<>
					<SettingsDanger
						label="Delete workspace"
						description={`Removes every pod, bot and thread in ${workspace.name}.`}
						action="Delete"
						onClick={() => setConfirmingDelete(true)}
					/>
					<DeleteDialog
						open={confirmingDelete}
						onOpenChange={setConfirmingDelete}
						title={`Delete ${workspace.name}?`}
						description="Its pods, bots, conversations and connections are deleted, and everyone in it loses it. This can't be undone."
						pending={deleteWorkspace.isPending}
						error={deleteWorkspace.error ? failureMessage(deleteWorkspace.error) : undefined}
						onDelete={() => confirmDelete(workspace.id)}
					/>
				</>
			)}
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
	const session = useSession();
	const signOut = useSignOut();
	const updateName = useUpdateName();
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const backToProfile = useBackToHere("You");
	const user = session.user;
	if (!user) return null;

	return (
		<SettingsPage
			hero={<PersonAvatar person={user} size={44} />}
			title={user.name}
			description={user.email}
		>
			<SettingsGroup label="Account">
				<SettingsNameRow
					name={user.name}
					maxLength={USER_NAME_MAX_LENGTH}
					savePending={updateName.isPending}
					error={updateName.error ? failureMessage(updateName.error) : undefined}
					onCommit={(name) => updateName.mutateAsync(name)}
				/>
				<SettingsRow label="Email" trailing={<SettingsValue>{user.email}</SettingsValue>} />
			</SettingsGroup>
			<SettingsGroup label="Appearance">
				<SettingsRow label="Theme" trailing={<ThemeChoice />} />
			</SettingsGroup>
			{/* A phone opens your settings from here alone, without the list beside them that has it. */}
			{phone && (
				<SettingsGroup>
					<SettingsRow
						label="Notifications"
						chevron
						render={
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "notifications" }}
								state={backToProfile}
							/>
						}
					/>
				</SettingsGroup>
			)}
			<ReferralLinkSettings />
			<SettingsDanger
				label="Sign out"
				description="Signs you out on this device."
				action="Sign out"
				onClick={() => void signOut()}
			/>
		</SettingsPage>
	);
}

/** How long Copied shows before the button reads Copy link again. */
const COPIED_FEEDBACK_MS = 2000;

/** The link that lets somebody new sign up, where the installation signs people up by referral. */
function ReferralLinkSettings() {
	const { data: link } = useReferralLink();
	const reset = useResetReferralLink();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
		return () => clearTimeout(timer);
	}, [copied]);
	if (!link) return null;

	function copy(url: string) {
		void navigator.clipboard
			?.writeText(url)
			.then(() => setCopied(true))
			.catch(() => setCopied(false));
	}

	return (
		<SettingsGroup
			className="flex flex-col gap-3 p-4"
			note={
				<span className="flex items-center justify-between gap-3">
					<span>
						{reset.error ? failureMessage(reset.error) : "Shared it somewhere you shouldn't have?"}
					</span>
					<Button
						variant="ghost"
						size="bare"
						disabled={reset.isPending}
						onClick={() => {
							setCopied(false);
							reset.mutate();
						}}
						className="rounded-md px-1 py-0.5 text-xs"
					>
						<RotateCcw aria-hidden />
						{reset.isPending ? "Resetting…" : "Reset link"}
					</Button>
				</span>
			}
		>
			<div className="flex flex-col gap-1">
				<h3 className="m-0 font-medium text-[14px] text-foreground">Share your invite link</h3>
				<p className="m-0 text-muted-foreground text-xs">
					Anyone with it can sign up and get a workspace of their own.
				</p>
			</div>
			<div className="flex h-11 min-w-0 items-center gap-2.5 rounded-lg border border-settings-card-border bg-background pr-1.5 pl-3.5">
				<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
					{withoutScheme(link)}
				</span>
				<Button
					size="sm"
					onClick={() => copy(link)}
					className="bg-link text-background hover:bg-link hover:opacity-90"
				>
					{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</SettingsGroup>
	);
}

/** A link as people read it: `sugabots.app/join/…`, since every one starts with https://. */
function withoutScheme(url: string): string {
	return url.replace(/^https?:\/\//, "");
}
