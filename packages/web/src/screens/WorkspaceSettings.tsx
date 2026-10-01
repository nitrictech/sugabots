import { USER_NAME_MAX_LENGTH, type WorkspaceRole, workspaceRoleLabel } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { client } from "@/api.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useReferralLink, useResetReferralLink } from "@/lib/referrals.ts";
import { useSession, useUpdateName } from "@/lib/session.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";
import {
	useDeleteWorkspace,
	useWorkspace,
	useWorkspaceMembers,
	useWorkspacePermissions,
	useWorkspaceRole,
} from "@/lib/workspace.ts";
import type { WorkspaceSettingSection } from "@/lib/workspace-settings.ts";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsControlRow,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { DefaultModelSettings, ModelsSettings, SystemModelSettings } from "./ModelsSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { WorkspaceRoutinesSettings } from "./RoutinesSettings.tsx";
import { UsageSettings } from "./UsageSettings.tsx";
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
	modelChoice,
	selectedMemberId,
}: {
	section: WorkspaceSettingSection;
	selectedAgentId?: string;
	selectedPodId?: string;
	connectionSignInError?: string;
	selectedAgentTab?: "routines";
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
					{section === "general" && <GeneralSettings role={role} canDelete={may.deleteWorkspace} />}
					{section === "profile" && <ProfileSettings />}
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
						<SettingsPage title="Web search" description="How bots look things up online.">
							{may.manageProviders ? (
								<WebSearchSettings />
							) : (
								<Alert>Only workspace administrators can manage web search.</Alert>
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

function GeneralSettings({
	role,
	canDelete,
}: {
	role: WorkspaceRole | undefined;
	canDelete: boolean;
}) {
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const deleteWorkspace = useDeleteWorkspace();
	const navigate = useNavigate();
	if (!workspace) return null;
	const people = members?.length;

	async function confirmDelete(workspaceId: string) {
		try {
			await deleteWorkspace.mutateAsync(workspaceId);
		} catch {
			return;
		}
		await navigate({ to: "/", replace: true });
	}

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
			{canDelete && (
				<>
					<SettingsDanger onClick={() => setConfirmingDelete(true)}>
						Delete workspace
					</SettingsDanger>
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
	const navigate = useNavigate();
	const updateName = useUpdateName();
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
				<NameRow
					name={user.name}
					savePending={updateName.isPending}
					error={updateName.error ? failureMessage(updateName.error) : undefined}
					onCommit={(name) => updateName.mutateAsync(name)}
				/>
				<SettingsRow label="Email" trailing={<SettingsValue>{user.email}</SettingsValue>} />
			</SettingsGroup>
			<ReferralLinkSettings />
			<SettingsDanger onClick={() => void signOut()}>Sign out</SettingsDanger>
		</SettingsPage>
	);
}

/**
 * Your name, edited in place, which saves trimmed when you leave it or press
 * Enter. Escape, or leaving it blank or unchanged, puts the name back; so does
 * a save that fails, and `error` says why under it.
 */
function NameRow({
	name,
	savePending,
	error,
	onCommit,
}: {
	name: string;
	savePending: boolean;
	error: string | undefined;
	onCommit: (name: string) => Promise<unknown>;
}) {
	const [draft, setDraft] = useState(name);
	const id = useId();

	function commit() {
		const next = draft.trim();
		if (savePending || next === name || next === "") {
			setDraft(name);
			return;
		}
		setDraft(next);
		void onCommit(next).catch(() => setDraft(name));
	}

	return (
		<>
			<SettingsControlRow label="Name" htmlFor={id}>
				<input
					id={id}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") setDraft(name);
					}}
					maxLength={USER_NAME_MAX_LENGTH}
					className="min-w-0 flex-1 rounded-md bg-transparent text-[14.5px] text-foreground outline-none focus-visible:shadow-(--ring-shadow)"
				/>
			</SettingsControlRow>
			{error && (
				<Alert className="border-border border-b px-4 py-2.5 last:border-b-0">{error}</Alert>
			)}
		</>
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
						className="rounded-md px-1 py-0.5 text-sm"
					>
						<RotateCcw aria-hidden />
						{reset.isPending ? "Resetting…" : "Reset link"}
					</Button>
				</span>
			}
		>
			<div className="flex flex-col gap-1">
				<h3 className="m-0 font-semibold text-[15px] text-foreground">Share your invite link</h3>
				<p className="m-0 text-muted-foreground text-sm">
					Anyone with it can sign up and get a workspace of their own.
				</p>
			</div>
			<div className="flex min-w-0 items-center gap-3 rounded-[12px] bg-background py-1.5 pr-1.5 pl-3.5">
				<span className="min-w-0 flex-1 truncate font-mono text-[14px] text-foreground">
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
