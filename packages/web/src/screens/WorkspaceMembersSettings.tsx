import {
	WORKSPACE_ROLES,
	type WorkspaceRole,
	workspaceRoleDescription,
	workspaceRoleLabel,
	workspaceRoleOf,
} from "@sugabots/contracts";
import { Ellipsis, Mail, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	useCancelWorkspaceInvitation,
	useInviteWorkspaceMember,
	useLeaveWorkspace,
	useRemoveWorkspaceMember,
	useUpdateWorkspaceMemberRole,
	useWorkspaceInvitations,
	useWorkspaceMembers,
} from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { Field } from "@/ui/field.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { SurfaceHeader, SurfaceTitle } from "@/ui/surface.tsx";

/**
 * The people in a workspace, and the people who have been asked and have not
 * arrived yet.
 *
 * Both are one list. An invitation is a person in a state rather than a form
 * left open at the bottom of the page, so it sits in the roster showing what
 * it is waiting for, and inviting happens behind a button.
 *
 * Every role is chosen with its description beside it rather than after
 * reading helper text somewhere else. That sentence is
 * `workspaceRoleDescription`, which lives beside the grants it describes so
 * the two move together.
 *
 * Whoever may manage members gets the controls and everybody else reads the
 * same list without them. `docs/permissions.md` says what they mean, and the
 * API decides either way.
 */

export function WorkspaceMembersSettings({
	workspaceId,
	canManage,
	currentUserId,
}: {
	workspaceId: string;
	/** `workspace.members.manage`, as the API resolved it. */
	canManage: boolean;
	currentUserId?: string;
}) {
	const members = useWorkspaceMembers(workspaceId);
	const invitations = useWorkspaceInvitations(workspaceId);
	const [inviting, setInviting] = useState(false);
	const people = members.data?.length ?? 0;

	return (
		<div className="flex max-w-2xl flex-col gap-6">
			<div className="flex items-center gap-4">
				{/* The section's own heading: the page's h1 is the breadcrumb above it. */}
				<h2 className="m-0 min-w-0 flex-1 font-semibold text-heading text-xl">
					{people === 1 ? "1 person in this workspace" : `${people} people in this workspace`}
				</h2>
				{canManage && (
					<Button className="shrink-0" onClick={() => setInviting(true)}>
						<Plus size={15} />
						Invite people
					</Button>
				)}
			</div>

			{members.isPending ? (
				<p className="m-0 text-md text-muted-foreground">Loading members…</p>
			) : members.error ? (
				<Alert>Members could not be loaded. Reload this page to try again.</Alert>
			) : (
				<Roster
					workspaceId={workspaceId}
					canManage={canManage}
					currentUserId={currentUserId}
					members={members.data ?? []}
					invitations={invitations.data ?? []}
				/>
			)}

			<Dialog open={inviting} onOpenChange={setInviting}>
				<InvitePanel workspaceId={workspaceId} done={() => setInviting(false)} />
			</Dialog>
		</div>
	);
}

type Member = NonNullable<ReturnType<typeof useWorkspaceMembers>["data"]>[number];
type Invitation = NonNullable<ReturnType<typeof useWorkspaceInvitations>["data"]>[number];

function Roster({
	workspaceId,
	canManage,
	currentUserId,
	members,
	invitations,
}: {
	workspaceId: string;
	canManage: boolean;
	currentUserId?: string;
	members: Member[];
	invitations: Invitation[];
}) {
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId);
	const remove = useRemoveWorkspaceMember(workspaceId);
	const leave = useLeaveWorkspace(workspaceId);
	const cancel = useCancelWorkspaceInvitation(workspaceId);
	const invite = useInviteWorkspaceMember(workspaceId);
	const [removing, setRemoving] = useState<{ id: string; name: string }>();
	const [leaving, setLeaving] = useState(false);
	const [copied, setCopied] = useState<string>();
	const [copyFailed, setCopyFailed] = useState(false);

	const failure = updateRole.error ?? cancel.error ?? invite.error;

	async function copyLink(invitationId: string) {
		const link = new URL(`/invite/${encodeURIComponent(invitationId)}`, window.location.origin);
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(link.toString());
		} catch {
			setCopyFailed(true);
			return;
		}
		setCopyFailed(false);
		setCopied(invitationId);
	}

	if (members.length === 0) {
		return <p className="m-0 text-md text-muted-foreground">No members yet.</p>;
	}

	return (
		<div className="flex flex-col gap-2.5">
			<ul className="overflow-hidden rounded-xl border border-border-subtle">
				{members.map((member) => {
					const role = workspaceRoleOf(member.role);
					// Your own access is not yours to change here. Demoting yourself
					// takes away the control you would need to undo it, and the API only
					// stops the very last administrator from doing it — so the one
					// person who cannot get stuck is the only one it stops. Leaving is
					// different: you are gone rather than present and powerless, so it
					// stays, behind a menu and a confirmation.
					const isYou = member.userId === currentUserId;
					return (
						<li
							key={member.id}
							className="flex min-h-16 flex-wrap items-center gap-3 border-border-subtle border-b px-4 py-3 last:border-b-0"
						>
							{member.user.image ? (
								<img
									src={member.user.image}
									alt=""
									className="size-9 shrink-0 rounded-full object-cover"
								/>
							) : (
								<span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted font-semibold text-heading text-sm">
									{member.user.name.trim().charAt(0).toUpperCase() || "?"}
								</span>
							)}
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-heading text-md">
									{member.user.name}
									{isYou && (
										<span className="ml-2 font-normal text-muted-foreground text-sm">you</span>
									)}
								</p>
								<p className="truncate text-muted-foreground text-sm">{member.user.email}</p>
							</div>
							{canManage && !isYou ? (
								<RolePicker
									label={`Access for ${member.user.name}`}
									role={role}
									pending={updateRole.isPending}
									onChange={(next) => updateRole.mutate({ memberId: member.id, role: next })}
								/>
							) : (
								<RoleLabel role={role} />
							)}
							<RowMenu label={`${member.user.name} options`}>
								{isYou ? (
									<DropdownMenuItem variant="destructive" onClick={() => setLeaving(true)}>
										Leave workspace
									</DropdownMenuItem>
								) : canManage ? (
									<DropdownMenuItem
										variant="destructive"
										onClick={() => setRemoving({ id: member.id, name: member.user.name })}
									>
										Remove from workspace
									</DropdownMenuItem>
								) : null}
							</RowMenu>
						</li>
					);
				})}

				{invitations.map((invitation) => (
					<li
						key={invitation.id}
						className="flex min-h-16 flex-wrap items-center gap-3 border-border-subtle border-b bg-sunken px-4 py-3 last:border-b-0"
					>
						<span className="grid size-9 shrink-0 place-items-center rounded-full border border-border-subtle border-dashed text-muted-foreground">
							<Mail size={15} aria-hidden />
						</span>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-heading text-md">{invitation.email}</p>
							<p className="truncate text-muted-foreground text-sm">
								{copied === invitation.id ? "Invitation link copied." : "Invited, not yet accepted"}
							</p>
						</div>
						<RoleLabel role={workspaceRoleOf(invitation.role)} />
						<RowMenu label={`Invitation for ${invitation.email} options`}>
							{canManage ? (
								<>
									<DropdownMenuItem onClick={() => copyLink(invitation.id)}>
										Copy invitation link
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() =>
											invite.mutate({
												email: invitation.email,
												role: workspaceRoleOf(invitation.role) ?? "member",
												resend: true,
											})
										}
									>
										Send it again
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										variant="destructive"
										onClick={() => cancel.mutate(invitation.id)}
									>
										Revoke invitation
									</DropdownMenuItem>
								</>
							) : null}
						</RowMenu>
					</li>
				))}
			</ul>

			{copyFailed && <Alert>Your browser could not copy the invitation link.</Alert>}
			{failure != null && <Alert>{failureMessage(failure)}</Alert>}

			<DeleteDialog
				open={removing !== undefined}
				onOpenChange={(open) => !open && setRemoving(undefined)}
				title={`Remove ${removing?.name ?? "this person"}?`}
				description="They lose this workspace and every pod in it, and their Personal pod and its conversations are deleted. Pods they made stay."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={async () => {
					if (!removing) return;
					try {
						await remove.mutateAsync(removing.id);
					} catch {
						return;
					}
					setRemoving(undefined);
				}}
			/>

			<DeleteDialog
				open={leaving}
				onOpenChange={setLeaving}
				title="Leave this workspace?"
				description="You lose every pod in it, and your Personal pod and its conversations are deleted. Getting back in means somebody inviting you again."
				pending={leave.isPending}
				error={leave.error ? failureMessage(leave.error) : undefined}
				onDelete={async () => {
					try {
						await leave.mutateAsync();
					} catch {
						return;
					}
					setLeaving(false);
				}}
			/>
		</div>
	);
}

/**
 * A role, chosen with each option's description beside it.
 *
 * `role` is `undefined` for somebody whose stored role this product does not
 * implement, which grants nothing. Nothing is selected in that case rather
 * than a role they do not hold being shown as though they did.
 */
function RolePicker({
	label,
	role,
	pending,
	onChange,
}: {
	label: string;
	role: WorkspaceRole | undefined;
	pending: boolean;
	onChange: (role: WorkspaceRole) => void;
}) {
	return (
		<Select
			value={role ?? ""}
			onValueChange={(chosen) => {
				const next = workspaceRoleOf(chosen);
				if (next && next !== role) onChange(next);
			}}
		>
			<SelectTrigger aria-label={label} className="w-36 shrink-0" disabled={pending}>
				<SelectValue>{(value: string) => workspaceRoleLabel(workspaceRoleOf(value))}</SelectValue>
			</SelectTrigger>
			{/*
			 * Wider than the trigger, and dropped below it rather than laid over
			 * it. The popup is `w-(--anchor-width)` by default, which is right for
			 * a list of bare labels and far too narrow for one carrying a sentence
			 * per option — at the trigger's width every description wrapped four
			 * lines deep. `--available-width` keeps it on screen when there is less
			 * room than that.
			 */}
			<SelectContent
				align="end"
				alignItemWithTrigger={false}
				className="w-[340px] max-w-(--available-width)"
			>
				{WORKSPACE_ROLES.map((choice) => (
					<SelectItem key={choice} value={choice} className="items-start py-2.5">
						<span className="flex flex-col gap-1 whitespace-normal">
							<span className="font-medium text-heading">{workspaceRoleLabel(choice)}</span>
							<span className="text-muted-foreground text-sm leading-snug">
								{workspaceRoleDescription(choice)}
							</span>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** A role you cannot change here, sized and padded like `RolePicker` so the column lines up. */
function RoleLabel({ role }: { role: WorkspaceRole | undefined }) {
	return (
		<span className="w-36 shrink-0 px-3 font-medium text-muted-foreground text-sm">
			{workspaceRoleLabel(role)}
		</span>
	);
}

/** The row's overflow menu, or a gap the width of one when it would be empty. */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
	if (!children) {
		return <span className="size-6 shrink-0" aria-hidden />;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<IconButton label={label} variant="quiet" className="shrink-0">
						<Ellipsis />
					</IconButton>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-52">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function InvitePanel({ workspaceId, done }: { workspaceId: string; done: () => void }) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<WorkspaceRole>("member");
	const [copyError, setCopyError] = useState(false);
	const invite = useInviteWorkspaceMember(workspaceId);
	const group = useId();

	async function submit(event: FormEvent) {
		event.preventDefault();
		setCopyError(false);
		let invitation: Awaited<ReturnType<typeof invite.mutateAsync>>;
		try {
			invitation = await invite.mutateAsync({ email, role });
		} catch {
			return;
		}
		const link = new URL(`/invite/${encodeURIComponent(invitation.id)}`, window.location.origin);
		try {
			if (!navigator.clipboard) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(link.toString());
		} catch {
			setCopyError(true);
			return;
		}
		done();
	}

	return (
		<DialogForm onSubmit={submit}>
			<SurfaceHeader>
				<SurfaceTitle
					title={<DialogTitle>Invite people</DialogTitle>}
					subtitle="Each invite becomes a link that only works for that address"
				/>
			</SurfaceHeader>
			<DialogFormBody>
				<Field id="invite-email" label="Email address">
					<Input
						id="invite-email"
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						placeholder="teammate@example.com"
						required
						disabled={invite.isPending}
					/>
				</Field>
				<fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
					<legend className="pb-2 font-medium text-foreground text-sm">Join as</legend>
					{WORKSPACE_ROLES.map((choice) => (
						<label
							key={choice}
							className="flex cursor-pointer items-start gap-3 rounded-xl border border-border-subtle p-3 focus-within:ring-2 focus-within:ring-ring has-checked:border-primary has-checked:bg-primary-tint"
						>
							<input
								type="radio"
								name={group}
								value={choice}
								checked={role === choice}
								onChange={() => setRole(choice)}
								disabled={invite.isPending}
								className="mt-0.5 size-4 shrink-0 accent-primary"
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium text-heading text-md">
									{workspaceRoleLabel(choice)}
								</span>
								<span className="text-muted-foreground text-sm">
									{workspaceRoleDescription(choice)}
								</span>
							</span>
						</label>
					))}
				</fieldset>
				{copyError && (
					<Alert>The invitation was created, but your browser could not copy its link.</Alert>
				)}
				{invite.error !== null && <Alert>{failureMessage(invite.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter>
				<span className="mr-auto text-muted-foreground text-sm">Links expire after two days</span>
				<Button type="button" variant="outline" disabled={invite.isPending} onClick={done}>
					Cancel
				</Button>
				<Button type="submit" disabled={invite.isPending}>
					{invite.isPending ? "Creating link…" : "Copy invitation link"}
				</Button>
			</DialogFormFooter>
		</DialogForm>
	);
}
