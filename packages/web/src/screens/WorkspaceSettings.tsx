import { type Liveliness, livelinessLevels } from "@sugabots/avatars";
import {
	PERSON_NAME_MAX_LENGTH,
	WORKSPACE_NAME_MAX_LENGTH,
	type WorkspaceRole,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useLivelinessChoice } from "@/lib/liveliness.tsx";
import { SETTINGS_BESIDE, useMediaQuery } from "@/lib/media.ts";
import { countOf } from "@/lib/name-list.ts";
import { useProjects } from "@/lib/projects.ts";
import { useReferralLink, useResetReferralLink } from "@/lib/referrals.ts";
import { useSession, useSignOut, useUpdateName } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { type Theme, useTheme } from "@/lib/theme.ts";
import {
	useDeleteWorkspace,
	useMemberships,
	useUpdateWorkspace,
	useWorkspace,
	useWorkspacePermissions,
	useWorkspaceRole,
	useWorkspaceTimeZone,
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
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { useCopy } from "@/ui/use-copy.ts";
import { ComputerSettings } from "./ComputerSettings.tsx";
import { DefaultModelSettings, ModelsSettings, SystemModelSettings } from "./ModelsSettings.tsx";
import { NotificationsSettings } from "./NotificationsSettings.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import { TimeZoneDialog } from "./TimeZoneDialog.tsx";
import { UsageSettings } from "./UsageSettings.tsx";
import { WebSearchSettings } from "./WebSearchSettings.tsx";
import { WorkspacePeopleSettings } from "./WorkspacePeopleSettings.tsx";

export function WorkspaceSettings({
	section,
	selectedProviderId,
	modelChoice,
	selectedMembershipId,
}: {
	section: WorkspaceSettingSection;
	/** The provider open on the Models page. */
	selectedProviderId?: string;
	/** Which model the Models page shows the choice of instead: new bots' or the system bots'. */
	modelChoice?: "default" | "system";
	/** The membership open on the People page. */
	selectedMembershipId?: string;
}) {
	const { workspace, isPending } = useWorkspace();
	const session = useSession();
	const may = useWorkspacePermissions();
	const role = useWorkspaceRole();

	// The shell sends somebody in no workspace to workspace setup, so there is always one here.
	if (isPending || !workspace) return null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{section === "providers" && may.manageProviders ? (
				modelChoice === "system" && may.chooseSystemModel ? (
					<SystemModelSettings />
				) : modelChoice === "default" ? (
					<DefaultModelSettings />
				) : selectedProviderId ? (
					<ProviderSettings providerId={selectedProviderId} />
				) : (
					<ModelsSettings />
				)
			) : (
				<>
					{section === "general" && (
						<GeneralSettings
							role={role}
							canUpdate={may.updateWorkspace}
							canDelete={may.deleteWorkspace}
						/>
					)}
					{section === "account" && <AccountSettings />}
					{section === "notifications" && <NotificationsSettings />}
					{section === "people" && (
						<WorkspacePeopleSettings
							workspaceId={workspace.id}
							canManage={may.managePeople}
							canManageAdmins={may.manageAdmins}
							canHandOverOwnership={may.handOverOwnership}
							currentPersonId={session.person?.id}
							selectedMembershipId={selectedMembershipId}
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
					{section === "computers" && (
						<SettingsPage
							title="Computers"
							description="Give each project and each bot a computer to run commands, browse and edit files on."
						>
							{may.manageProviders ? (
								<ComputerSettings />
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
								<Alert>
									Only workspace administrators can see what the workspace's models cost.
								</Alert>
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
	projects: number | undefined,
): string | undefined {
	if (people === undefined || projects === undefined) return undefined;
	return `Workspace with ${countOf(people, "person", "people")} and ${countOf(projects, "project", "projects")}`;
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
	const { data: memberships } = useMemberships(workspace?.id);
	const { data: projects } = useProjects();
	const [choosingTimeZone, setChoosingTimeZone] = useState(false);
	// Loaded with the page, so the dialog opens with its automations note already in place.
	useWorkspaceTimeZone(workspace?.id ?? "", canUpdate && workspace !== undefined);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const deleteWorkspace = useDeleteWorkspace();
	const update = useUpdateWorkspace(workspace?.id);
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
		<SettingsPage
			title="General"
			description={workspaceSummary(memberships?.length, projects?.length)}
		>
			<SettingsGroup>
				{canUpdate ? (
					// Keeps the slug: it is in every link to the workspace, which nothing redirects from.
					<SettingsNameRow
						name={workspace.name}
						maxLength={WORKSPACE_NAME_MAX_LENGTH}
						savePending={update.isPending}
						error={update.error ? failureMessage(update.error) : undefined}
						onCommit={(name) => update.mutateAsync({ name, slug: workspace.slug })}
					/>
				) : (
					<SettingsRow label="Name" trailing={<SettingsValue>{workspace.name}</SettingsValue>} />
				)}
				<SettingsRow
					label="Time zone"
					sub="Automations run on this clock"
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
						description={`Removes every project, bot and chat in ${workspace.name}.`}
						action="Delete"
						onClick={() => setConfirmingDelete(true)}
					/>
					<DeleteDialog
						open={confirmingDelete}
						onOpenChange={setConfirmingDelete}
						title={`Delete ${workspace.name}?`}
						description="Its projects, bots, chats and connectors are deleted, and everyone in it loses it. This can't be undone."
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

/** What each level is called in settings; every level must have a name, so a new one can't be left out. */
const livelinessNames: Record<Liveliness, string> = {
	off: "Off",
	sometimes: "Sometimes",
	often: "Often",
};

const livelinessOptions = livelinessLevels.map((level) => ({
	value: level,
	label: livelinessNames[level],
}));
function LivelinessChoice() {
	const [liveliness, setLiveliness] = useLivelinessChoice();
	return (
		<SegmentedControl
			label="Animations"
			options={livelinessOptions}
			value={liveliness}
			onChange={setLiveliness}
		/>
	);
}

function AccountSettings() {
	const session = useSession();
	const signOut = useSignOut();
	const updateName = useUpdateName();
	const openedFromCard = !useMediaQuery(SETTINGS_BESIDE);
	const backToAccount = useBackToHere("You");
	const signedIn = session.person;
	if (!signedIn) return null;

	return (
		<SettingsPage
			hero={<PersonAvatar person={signedIn} size={44} />}
			title={signedIn.name}
			description={signedIn.email}
		>
			<SettingsGroup label="Account">
				<SettingsNameRow
					name={signedIn.name}
					maxLength={PERSON_NAME_MAX_LENGTH}
					savePending={updateName.isPending}
					error={updateName.error ? failureMessage(updateName.error) : undefined}
					onCommit={(name) => updateName.mutateAsync(name)}
				/>
				<SettingsControlRow label="Email">
					{/* In the name's column and at its size, which a touch screen keeps at 16px for its field. */}
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground pointer-coarse:text-base">
						{signedIn.email}
					</span>
				</SettingsControlRow>
			</SettingsGroup>
			<SettingsGroup label="Appearance">
				<SettingsRow label="Theme" trailing={<ThemeChoice />} />
				<SettingsRow
					label="Animations"
					sub="How often bots' faces move"
					trailing={<LivelinessChoice />}
				/>
			</SettingsGroup>
			{/* Below a laptop's width your account is opened from a card, with no list beside it that has Notifications. */}
			{openedFromCard && (
				<SettingsGroup>
					<SettingsRow
						label="Notifications"
						chevron
						render={
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "notifications" }}
								state={backToAccount}
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

/** The link that lets somebody new sign up, where the server signs people up by referral. */
function ReferralLinkSettings() {
	const { data: link } = useReferralLink();
	const reset = useResetReferralLink();
	const { copied, label, copy } = useCopy("Copy");
	if (!link) return null;

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
						onClick={() => reset.mutate()}
						className="rounded-md px-1 py-0.5 text-xs"
					>
						<RotateCcw aria-hidden />
						{reset.isPending ? "Resetting…" : "Reset link"}
					</Button>
				</span>
			}
		>
			<div className="flex flex-col gap-1">
				<h3 className="m-0 font-medium text-sm text-foreground">Share your referral link</h3>
				<p className="m-0 text-muted-foreground text-xs">
					Anyone with it can sign up and get a workspace of their own.
				</p>
			</div>
			<div className="flex h-11 min-w-0 items-center gap-2.5 rounded-lg border border-settings-card-border bg-background pr-1.5 pl-3.5">
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
					{withoutScheme(link)}
				</span>
				<Button size="sm" onClick={() => void copy(link)}>
					{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
					{label}
				</Button>
			</div>
		</SettingsGroup>
	);
}

/** A link as people read it: `sugabots.app/join/…`, since every one starts with https://. */
function withoutScheme(url: string): string {
	return url.replace(/^https?:\/\//, "");
}
