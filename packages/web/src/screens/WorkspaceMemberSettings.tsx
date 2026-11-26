import {
	ASSIGNABLE_WORKSPACE_ROLES,
	type AssignableWorkspaceRole,
	administersWorkspace,
	INVITATION_LIFETIME_DAYS,
	type Project,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { memberSettingsLink, settingsSectionLink } from "@/lib/links.ts";
import { formatDate, formatTimeAfterVerb } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import { projectHeadcount } from "@/lib/project-headcount.ts";
import { usePlaceProjectMember, useProjectMembers, useProjects } from "@/lib/projects.ts";
import {
	type InvitationFailure,
	sendInvitations,
	useCancelWorkspaceInvitation,
	useChangeRole,
	useHandOverOwnership,
	useLeaveWorkspace,
	useMembershipCleanupPending,
	useMemberships,
	useRemoveMembership,
	useSendInvitation,
	useWorkspaceInvitations,
} from "@/lib/workspace.ts";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Alert, Success } from "@/ui/alert.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	PageBackLink,
	SettingsAddButton,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowAlert,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/**
 * The members in a workspace and the invitations still out, each member a
 * click into their own page: their role, the projects they are in, and removing
 * them. Whoever may manage members gets the controls, over administrators
 * only when they may manage those too; everybody else reads the same pages
 * without them. The API decides either way.
 */
export function WorkspaceMemberSettings({
	workspaceId,
	canManage,
	canManageAdmins,
	canHandOverOwnership,
	currentUserId,
	selectedMembershipId,
}: {
	workspaceId: string;
	/** `workspace.members.manage`, as the API resolved it. */
	canManage: boolean;
	/** `workspace.admins.manage`: making, unmaking and removing administrators. */
	canManageAdmins: boolean;
	/** `workspace.ownership.handOver`: handing the workspace to somebody else. */
	canHandOverOwnership: boolean;
	currentUserId?: string;
	selectedMembershipId?: string;
}) {
	const memberships = useMemberships(workspaceId);

	if (selectedMembershipId !== undefined) {
		if (memberships.isPending) return null;
		const membership = memberships.data?.find((one) => one.id === selectedMembershipId);
		if (!membership) {
			return (
				<EmptyState page="min" title="No such member here">
					They may have left the workspace, or been removed from it.
				</EmptyState>
			);
		}
		return (
			<MemberPage
				key={membership.id}
				workspaceId={workspaceId}
				membership={membership}
				canManage={canManage}
				canManageAdmins={canManageAdmins}
				canHandOverOwnership={canHandOverOwnership}
				isYou={membership.member.id === currentUserId}
			/>
		);
	}

	return (
		<Roster
			workspaceId={workspaceId}
			canManage={canManage}
			canManageAdmins={canManageAdmins}
			currentUserId={currentUserId}
			memberships={memberships}
		/>
	);
}

type Membership = NonNullable<ReturnType<typeof useMemberships>["data"]>[number];
type Invitation = NonNullable<ReturnType<typeof useWorkspaceInvitations>["data"]>[number];

/** The roles somebody can be given, without Admin for whoever may not make one. */
function roleOptions(canManageAdmins: boolean) {
	return ASSIGNABLE_WORKSPACE_ROLES.filter((role) => canManageAdmins || role !== "admin").map(
		(role) => ({ value: role, label: workspaceRoleLabel(role) }),
	);
}

function Roster({
	workspaceId,
	canManage,
	canManageAdmins,
	currentUserId,
	memberships,
}: {
	workspaceId: string;
	canManage: boolean;
	canManageAdmins: boolean;
	currentUserId?: string;
	memberships: ReturnType<typeof useMemberships>;
}) {
	const invitations = useWorkspaceInvitations(workspaceId);
	const cleanupPending = useMembershipCleanupPending(workspaceId, memberships.dataUpdatedAt);
	const [inviting, setInviting] = useState(false);

	return (
		<SettingsPage
			title="Members"
			description="Everyone in the workspace. Add them to projects to work together there."
			headerAction={
				canManage && (
					<SettingsAddButton onClick={() => setInviting(true)}>Invite members</SettingsAddButton>
				)
			}
		>
			{cleanupPending && (
				<Success>
					Member removed. Their Personal Assistants’ computer cleanup will finish in the background.
				</Success>
			)}
			{memberships.isPending ? (
				<p className="m-0 text-xs text-muted-foreground">Loading members…</p>
			) : memberships.error ? (
				<Alert>Members could not be loaded. Reload this page to try again.</Alert>
			) : (
				<SettingsGroup label="Members">
					{memberships.data?.map((membership) => (
						<SettingsRow
							key={membership.id}
							icon={<MemberAvatar member={membership.member} size={24} />}
							label={
								membership.member.id === currentUserId
									? `${membership.member.name} (you)`
									: membership.member.name
							}
							sub={membership.member.email}
							trailing={<SettingsValue>{workspaceRoleLabel(membership.role)}</SettingsValue>}
							chevron
							render={<Link {...memberSettingsLink(membership)} />}
						/>
					))}
				</SettingsGroup>
			)}
			{(invitations.data?.length ?? 0) > 0 && (
				<Invitations
					workspaceId={workspaceId}
					invitations={invitations.data ?? []}
					canManage={canManage}
				/>
			)}
			<Dialog open={inviting} onOpenChange={setInviting}>
				<InviteMembersDialog
					workspaceId={workspaceId}
					canManageAdmins={canManageAdmins}
					done={() => setInviting(false)}
				/>
			</Dialog>
		</SettingsPage>
	);
}

function Invitations({
	workspaceId,
	invitations,
	canManage,
}: {
	workspaceId: string;
	invitations: readonly Invitation[];
	canManage: boolean;
}) {
	const invite = useSendInvitation(workspaceId);
	const cancel = useCancelWorkspaceInvitation(workspaceId);
	const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
	const failure = invite.error ?? cancel.error;

	return (
		<SettingsGroup
			label="Invited"
			note={`Invitations expire after ${INVITATION_LIFETIME_DAYS} days.`}
		>
			{invitations.map((invitation) => (
				<SettingsRow
					key={invitation.id}
					icon={
						<MemberAvatar member={{ name: invitation.email, email: invitation.email }} size={32} />
					}
					label={invitation.email}
					sub={resent.has(invitation.id) ? "Sent again" : invitationTimes(invitation, new Date())}
					trailing={
						canManage && (
							<span className="flex shrink-0 items-center gap-1">
								<Button
									variant="secondary"
									size="sm"
									disabled={invite.isPending}
									onClick={() =>
										invite.mutate(
											{
												email: invitation.email,
												role: invitation.role,
												resend: true,
											},
											{ onSuccess: () => setResent((sent) => new Set(sent).add(invitation.id)) },
										)
									}
								>
									Resend
								</Button>
								<IconButton
									label={`Revoke the invitation for ${invitation.email}`}
									variant="quiet"
									disabled={cancel.isPending}
									onClick={() => cancel.mutate(invitation.id)}
								>
									<X />
								</IconButton>
							</span>
						)
					}
				/>
			))}
			{failure != null && <SettingsRowAlert>{failureMessage(failure)}</SettingsRowAlert>}
		</SettingsGroup>
	);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** When the invitation went out and how long it has left, as one sentence: "Sent yesterday, expires in 8 hours". */
function invitationTimes(invitation: { sentAt: string; expiresAt: string }, now: Date): string {
	const sent = `Sent ${formatTimeAfterVerb(new Date(invitation.sentAt), now)}`;
	return `${sent}, ${expiryText(new Date(invitation.expiresAt).getTime() - now.getTime())}`;
}

/** Hours on its last day, then whole days, so a link with a day and a half to go says one day rather than two. */
function expiryText(leftMs: number): string {
	if (leftMs <= 0) return "expired";
	if (leftMs < HOUR_MS) return "expires in under an hour";
	if (leftMs < DAY_MS)
		return `expires in ${countOf(Math.floor(leftMs / HOUR_MS), "hour", "hours")}`;
	return `expires in ${countOf(Math.floor(leftMs / DAY_MS), "day", "days")}`;
}

function MemberPage({
	workspaceId,
	membership,
	canManage,
	canManageAdmins,
	canHandOverOwnership,
	isYou,
}: {
	workspaceId: string;
	membership: Membership;
	canManage: boolean;
	canManageAdmins: boolean;
	canHandOverOwnership: boolean;
	isYou: boolean;
}) {
	const updateRole = useChangeRole(workspaceId);
	const remove = useRemoveMembership(workspaceId);
	const leave = useLeaveWorkspace(workspaceId);
	const transfer = useHandOverOwnership(workspaceId);
	const projects = useProjects();
	const router = useRouter();
	const { leaveForPage } = useLeave();
	const [confirming, setConfirming] = useState(false);
	const [transferring, setTransferring] = useState(false);
	const role = membership.role;
	const isOwner = role === "owner";
	const listedProjects =
		projects.data?.filter((project) => project.isMember || project.visibility === "public") ?? [];
	// Your own role is not yours to change: demoting yourself takes away the
	// control you would need to undo it. Leaving stays, behind a confirmation.
	// The owner's role and place change only by their handing ownership on.
	const mayManageThem = canManage && !isYou && !isOwner && (role !== "admin" || canManageAdmins);
	const mayLeave = isYou && !isOwner;
	const ending = isYou ? leave : remove;

	async function confirmEnding() {
		try {
			if (isYou) await leave.mutateAsync();
			else await remove.mutateAsync(membership.id);
		} catch {
			return;
		}
		setConfirming(false);
		if (!isYou) {
			// Back to Members, or Members in their page's place, so Back never returns to
			// somebody no longer here.
			leaveForPage(router.buildLocation(settingsSectionLink("members")).href);
		}
	}

	return (
		<SettingsPage
			back={
				<PageBackLink
					label="Members"
					render={<Link {...settingsSectionLink("members")} aria-label="Back to Members" />}
				/>
			}
			hero={<MemberAvatar member={membership.member} size={44} />}
			title={membership.member.name}
			description={membership.member.email}
		>
			<SettingsGroup
				label="Role"
				note={
					isYou && isOwner
						? `${workspaceRoleDescription(role)} To leave, hand ownership over to somebody else first.`
						: workspaceRoleDescription(role)
				}
			>
				<SettingsRow
					label="Role"
					trailing={
						mayManageThem ? (
							<SegmentedControl
								label={`Role for ${membership.member.name}`}
								options={roleOptions(canManageAdmins)}
								value={role}
								onChange={(next) => updateRole.mutate({ membershipId: membership.id, role: next })}
							/>
						) : (
							<SettingsValue>{workspaceRoleLabel(role)}</SettingsValue>
						)
					}
				/>
				{updateRole.error && (
					<SettingsRowAlert>{failureMessage(updateRole.error)}</SettingsRowAlert>
				)}
			</SettingsGroup>
			{listedProjects.length > 0 && (
				<SettingsGroup
					label="Projects"
					note={
						administersWorkspace(role)
							? "Administrators are in every project."
							: "The projects they are in, and the public ones they could join."
					}
				>
					{listedProjects.map((project) => (
						<ProjectMembershipRow
							key={project.id}
							project={project}
							memberId={membership.member.id}
							name={membership.member.name}
							canManage={canManage && !administersWorkspace(role)}
						/>
					))}
				</SettingsGroup>
			)}
			<SettingsGroup label="Details">
				<SettingsRow
					label="Joined"
					trailing={<SettingsValue>{formatDate(new Date(membership.joinedAt))}</SettingsValue>}
				/>
			</SettingsGroup>
			{canHandOverOwnership && !isYou && (
				<SettingsGroup
					label="Ownership"
					note="The owner decides who administers the workspace, and is the only one who can hand it on."
				>
					<SettingsRow
						label={`Make ${membership.member.name} the owner`}
						chevron
						onClick={() => setTransferring(true)}
					/>
				</SettingsGroup>
			)}
			{(mayLeave || mayManageThem) && (
				<SettingsDanger
					label={isYou ? "Leave workspace" : "Remove from workspace"}
					description={
						isYou
							? "You lose access to every project and bot in the workspace."
							: "They lose access to every project and bot straight away."
					}
					action={isYou ? "Leave" : "Remove"}
					onClick={() => setConfirming(true)}
				/>
			)}
			<DeleteDialog
				open={transferring}
				onOpenChange={setTransferring}
				title={`Make ${membership.member.name} the owner?`}
				description={`You stay on as an admin. Only ${membership.member.name} can decide who else administers the workspace, or hand it back to you.`}
				confirmLabel="Transfer"
				pending={transfer.isPending}
				error={transfer.error ? failureMessage(transfer.error) : undefined}
				onDelete={() =>
					transfer.mutateAsync(membership.id).then(
						() => setTransferring(false),
						() => {},
					)
				}
			/>
			<DeleteDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={isYou ? "Leave this workspace?" : `Remove ${membership.member.name}?`}
				description={
					isYou
						? "You leave every project in it, and your Personal Assistants and their chats are deleted. Getting back in means somebody inviting you again."
						: "They leave this workspace and every project in it, and their Personal Assistants and their chats are deleted. Projects and other bots they made stay."
				}
				confirmLabel={isYou ? "Leave" : "Remove"}
				pending={ending.isPending}
				error={ending.error ? failureMessage(ending.error) : undefined}
				onDelete={confirmEnding}
			/>
		</SettingsPage>
	);
}

/** One project, with whether this member is on its roster and a switch to change that. */
function ProjectMembershipRow({
	project,
	memberId,
	name,
	canManage,
}: {
	project: Project;
	memberId: string;
	name: string;
	canManage: boolean;
}) {
	// The list of projects counts members only where the viewer may list them, and the roster is
	// asked for only there, since anywhere else the API refuses it.
	const members = useProjectMembers(project.memberCount === undefined ? undefined : project.id);
	const place = usePlaceProjectMember(project.id);
	const inProject = members.data?.some((member) => member.memberId === memberId) ?? false;
	const headcount = projectHeadcount({ members: project.memberCount, bots: project.botCount });

	return (
		<SettingsRow
			icon={<ProjectInitial project={project} size="row" />}
			label={project.name}
			sub={place.error ? failureMessage(place.error) : headcount}
			trailing={
				<Toggle
					label={`${name} is in ${project.name}`}
					checked={inProject}
					disabled={!canManage || members.isPending || place.isPending}
					onChange={(member) => place.mutate({ memberId, member })}
				/>
			}
		/>
	);
}

/** Emails separated by commas, spaces or new lines, each asked in with the same role. */
function InviteMembersDialog({
	workspaceId,
	canManageAdmins,
	done,
}: {
	workspaceId: string;
	/** Offers Admin only to whoever may make one. */
	canManageAdmins: boolean;
	done: () => void;
}) {
	const [text, setText] = useState("");
	const [role, setRole] = useState<AssignableWorkspaceRole>("editor");
	const [failed, setFailed] = useState<InvitationFailure[]>([]);
	const [sending, setSending] = useState(false);
	const invite = useSendInvitation(workspaceId);
	const emailsId = useId();
	const emails = [...new Set(text.split(/[\s,]+/).filter(Boolean))];

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (emails.length === 0) return;
		setSending(true);
		const failures = await sendInvitations(emails, role, invite.mutateAsync);
		setSending(false);
		if (failures.length === 0) {
			done();
			return;
		}
		// What went out is done; what is left is what to fix and send again.
		setFailed(failures);
		setText(failures.map((failure) => failure.email).join(", "));
	}

	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title="Invite members" />
			<DialogFormBody>
				<label htmlFor={emailsId} className="sr-only">
					Email addresses
				</label>
				<input
					id={emailsId}
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="Email addresses, separated by commas"
					disabled={sending}
					autoComplete="off"
					className="focus-ring w-full rounded-xl border border-settings-card-border bg-settings-card px-4 py-3.5 text-xs text-foreground leading-5 outline-none placeholder:text-muted-foreground"
				/>
				<SettingsGroup note={workspaceRoleDescription(role)}>
					<SettingsRow
						label="Role"
						trailing={
							<SegmentedControl
								label="Role"
								options={roleOptions(canManageAdmins)}
								value={role}
								onChange={setRole}
							/>
						}
					/>
				</SettingsGroup>
				{failed.length > 0 && (
					<Alert>
						{failed.map((failure) => (
							<span key={failure.email} className="block">
								{failure.email}: {failure.reason}
							</span>
						))}
					</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter
				action="Send"
				actionDisabled={sending || emails.length === 0}
				cancelDisabled={sending}
				onCancel={done}
			/>
		</DialogForm>
	);
}
