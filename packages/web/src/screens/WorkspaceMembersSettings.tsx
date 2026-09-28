import {
	type Pod,
	WORKSPACE_ROLES,
	type WorkspaceRole,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { usePlacePodMember, usePodMembers, usePods } from "@/lib/pods.ts";
import { useBackTarget, useBackToHere } from "@/lib/settings-back.tsx";
import {
	useCancelWorkspaceInvitation,
	useInviteWorkspaceMember,
	useLeaveWorkspace,
	useRemoveWorkspaceMember,
	useUpdateWorkspaceMemberRole,
	useWorkspaceInvitations,
	useWorkspaceMembers,
} from "@/lib/workspace.ts";
import { PodTile } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
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
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/**
 * The people in a workspace and the invitations still out, each person a
 * click into their own page: their role, the pods they are in, and removing
 * them. Whoever may manage members gets the controls; everybody else reads
 * the same pages without them. `docs/permissions.md` says what the roles
 * mean, and the API decides either way.
 */
export function WorkspaceMembersSettings({
	workspaceId,
	canManage,
	currentUserId,
	selectedMemberId,
}: {
	workspaceId: string;
	/** `workspace.members.manage`, as the API resolved it. */
	canManage: boolean;
	currentUserId?: string;
	selectedMemberId?: string;
}) {
	const members = useWorkspaceMembers(workspaceId);

	if (selectedMemberId !== undefined) {
		if (members.isPending) return null;
		const member = members.data?.find((one) => one.id === selectedMemberId);
		if (!member) {
			return (
				<div className="grid min-h-80 place-items-center p-6">
					<EmptyState title="No such person here">
						They may have left the workspace, or been removed from it.
					</EmptyState>
				</div>
			);
		}
		return (
			<MemberPage
				key={member.id}
				workspaceId={workspaceId}
				member={member}
				canManage={canManage}
				isYou={member.user.id === currentUserId}
			/>
		);
	}

	return (
		<Roster
			workspaceId={workspaceId}
			canManage={canManage}
			currentUserId={currentUserId}
			members={members}
		/>
	);
}

type Member = NonNullable<ReturnType<typeof useWorkspaceMembers>["data"]>[number];
type Invitation = NonNullable<ReturnType<typeof useWorkspaceInvitations>["data"]>[number];

const roleOptions = WORKSPACE_ROLES.map((role) => ({
	value: role,
	label: workspaceRoleLabel(role),
}));

function Roster({
	workspaceId,
	canManage,
	currentUserId,
	members,
}: {
	workspaceId: string;
	canManage: boolean;
	currentUserId?: string;
	members: ReturnType<typeof useWorkspaceMembers>;
}) {
	const backToMembers = useBackToHere("Members");
	const invitations = useWorkspaceInvitations(workspaceId);
	const [inviting, setInviting] = useState(false);

	return (
		<SettingsPage
			title="Members"
			description="People who can see pods and talk to their bots."
			headerAction={canManage && <Button onClick={() => setInviting(true)}>Invite people</Button>}
		>
			{members.isPending ? (
				<p className="m-0 text-md text-muted-foreground">Loading members…</p>
			) : members.error ? (
				<Alert>Members could not be loaded. Reload this page to try again.</Alert>
			) : (
				<SettingsGroup label="Members">
					{members.data?.map((member) => (
						<SettingsRow
							key={member.id}
							icon={<PersonAvatar name={member.user.name} image={member.user.image} size={32} />}
							label={member.user.name}
							sub={member.user.email}
							trailing={
								<SettingsValue>
									{member.user.id === currentUserId ? "You" : workspaceRoleLabel(member.role)}
								</SettingsValue>
							}
							chevron
							render={
								<Link
									from="/$workspace"
									to="./settings/members/$member"
									params={{ member: member.id }}
									state={backToMembers}
								/>
							}
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
				<InviteDialog workspaceId={workspaceId} done={() => setInviting(false)} />
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
	const invite = useInviteWorkspaceMember(workspaceId);
	const cancel = useCancelWorkspaceInvitation(workspaceId);
	const [resent, setResent] = useState<ReadonlySet<string>>(new Set());
	const failure = invite.error ?? cancel.error;

	return (
		<SettingsGroup label="Invited" note={`Invites expire after ${INVITE_LIFETIME_DAYS} days.`}>
			{invitations.map((invitation) => (
				<SettingsRow
					key={invitation.id}
					icon={<PersonAvatar name={invitation.email} size={32} />}
					label={invitation.email}
					sub={resent.has(invitation.id) ? "Sent again" : expiryText(invitation.expiresAt)}
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
			{failure != null && (
				<div className="border-border border-t px-4 py-3">
					<Alert>{failureMessage(failure)}</Alert>
				</div>
			)}
		</SettingsGroup>
	);
}

/** How long an invitation link lasts: the auth library's default, which the server keeps. */
const INVITE_LIFETIME_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left, so a link with a day and a half to go says one day rather than two. */
function expiryText(expiresAt: string): string {
	const left = new Date(expiresAt).getTime() - Date.now();
	if (left <= 0) return "Expired";
	const days = Math.floor(left / DAY_MS);
	if (days === 0) return "Expires within a day";
	return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

function MemberPage({
	workspaceId,
	member,
	canManage,
	isYou,
}: {
	workspaceId: string;
	member: Member;
	canManage: boolean;
	isYou: boolean;
}) {
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId);
	const remove = useRemoveWorkspaceMember(workspaceId);
	const leave = useLeaveWorkspace(workspaceId);
	const pods = usePods();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const back = useBackTarget({
		label: "Members",
		render: <Link from="/$workspace" to="./settings/$section" params={{ section: "members" }} />,
	});
	const role = member.role;
	const sharedPods = pods.data?.filter((pod) => pod.kind === "shared") ?? [];
	// Your own role is not yours to change: demoting yourself takes away the
	// control you would need to undo it. Leaving stays, behind a confirmation.
	const mayChangeRole = canManage && !isYou;
	const ending = isYou ? leave : remove;

	async function confirmEnding() {
		try {
			if (isYou) await leave.mutateAsync();
			else await remove.mutateAsync(member.id);
		} catch {
			return;
		}
		setConfirming(false);
		if (!isYou) {
			await navigate({
				from: "/$workspace",
				to: "./settings/$section",
				params: { section: "members" },
			});
		}
	}

	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			hero={<PersonAvatar name={member.user.name} image={member.user.image} size={88} />}
			title={member.user.name}
			description={member.user.email}
		>
			<SettingsGroup label="Role" note={role && workspaceRoleDescription(role)}>
				<SettingsRow
					label="Role"
					trailing={
						mayChangeRole && role ? (
							<SegmentedControl
								label={`Role for ${member.user.name}`}
								options={roleOptions}
								value={role}
								onChange={(next) => updateRole.mutate({ memberId: member.id, role: next })}
							/>
						) : (
							<SettingsValue>{workspaceRoleLabel(role)}</SettingsValue>
						)
					}
				/>
				{updateRole.error && (
					<div className="border-border border-t px-4 py-3">
						<Alert>{failureMessage(updateRole.error)}</Alert>
					</div>
				)}
			</SettingsGroup>
			{sharedPods.length > 0 && (
				<SettingsGroup
					label="Pods"
					note={
						role === "admin"
							? "Administrators are in every shared pod."
							: "They can talk to every bot in the pods they are in."
					}
				>
					{sharedPods.map((pod) => (
						<PodMembershipRow
							key={pod.id}
							pod={pod}
							userId={member.user.id}
							name={member.user.name}
							canManage={canManage && role !== "admin"}
						/>
					))}
				</SettingsGroup>
			)}
			<SettingsGroup label="Details">
				<SettingsRow
					label="Joined"
					trailing={<SettingsValue>{joinedDate(member.joinedAt)}</SettingsValue>}
				/>
			</SettingsGroup>
			{(isYou || canManage) && (
				<SettingsDanger onClick={() => setConfirming(true)}>
					{isYou ? "Leave workspace" : "Remove from workspace"}
				</SettingsDanger>
			)}
			<DeleteDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={isYou ? "Leave this workspace?" : `Remove ${member.user.name}?`}
				description={
					isYou
						? "You lose every pod in it, and your Personal pod and its conversations are deleted. Getting back in means somebody inviting you again."
						: "They lose this workspace and every pod in it, and their Personal pod and its conversations are deleted. Pods they made stay."
				}
				confirmLabel={isYou ? "Leave" : "Remove"}
				pending={ending.isPending}
				error={ending.error ? failureMessage(ending.error) : undefined}
				onDelete={confirmEnding}
			/>
		</SettingsPage>
	);
}

function joinedDate(joinedAt: string): string {
	return new Date(joinedAt).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** One shared pod, with whether this person is on its roster and a switch to change that. */
function PodMembershipRow({
	pod,
	userId,
	name,
	canManage,
}: {
	pod: Pod;
	userId: string;
	name: string;
	canManage: boolean;
}) {
	const members = usePodMembers(pod.id);
	const place = usePlacePodMember(pod.id);
	const { agents } = useAgents();
	const bots =
		agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];
	const people = members.data?.length;
	const inPod = members.data?.some((member) => member.userId === userId) ?? false;
	const counts = [
		`${bots.length} ${bots.length === 1 ? "bot" : "bots"}`,
		people !== undefined ? `${people} ${people === 1 ? "person" : "people"}` : undefined,
	].filter(Boolean);

	return (
		<SettingsRow
			icon={<PodTile bots={bots} color={pod.color} size={30} />}
			label={pod.name}
			sub={place.error ? failureMessage(place.error) : counts.join(", ")}
			trailing={
				<Toggle
					label={`${name} is in ${pod.name}`}
					checked={inPod}
					disabled={!canManage || members.isPending || place.isPending}
					onChange={(member) => place.mutate({ userId, member })}
				/>
			}
		/>
	);
}

/** Emails separated by commas, spaces or new lines, each asked in with the same role. */
function InviteDialog({ workspaceId, done }: { workspaceId: string; done: () => void }) {
	const [text, setText] = useState("");
	const [role, setRole] = useState<WorkspaceRole>("member");
	const [failed, setFailed] = useState<{ email: string; reason: string }[]>([]);
	const [sending, setSending] = useState(false);
	const invite = useInviteWorkspaceMember(workspaceId);
	const emailsId = useId();
	const emails = [...new Set(text.split(/[\s,]+/).filter(Boolean))];

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (emails.length === 0) return;
		setSending(true);
		const failures: { email: string; reason: string }[] = [];
		for (const email of emails) {
			try {
				await invite.mutateAsync({ email, role });
			} catch (error) {
				failures.push({ email, reason: failureMessage(error) });
			}
		}
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
			<DialogFormHeader title="Invite people" />
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
					className="focus-ring w-full rounded-panel bg-list px-4 py-3.5 text-[14.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<SettingsGroup note={workspaceRoleDescription(role)}>
					<SettingsRow
						label="Role"
						trailing={
							<SegmentedControl
								label="Role"
								options={roleOptions}
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
