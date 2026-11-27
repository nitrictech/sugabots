import { type ProjectMember, workspaceRoleLabel } from "@sugabots/contracts";
import { Minus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSession } from "@/lib/session.ts";
import { useMemberships } from "@/lib/workspace.ts";
import { Alert } from "@/ui/alert.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	SettingsAddButton,
	SettingsGroup,
	SettingsRow,
	SettingsRowAlert,
	SettingsValue,
} from "@/ui/settings-page.tsx";

/*
 * The members of a project or a private bot, as their settings list them,
 * and the menu that adds more. Neither has roles of its own, so the label
 * after a name is their standing in the workspace. Who can be taken out is
 * the API's answer: administrators are in every one.
 */

/** A member as a project's or a private bot's members list gives them. */
type ListedMember = ProjectMember;

/** What a dialog asks before `member` is taken out, and what its button says. */
interface Confirmation {
	readonly title: string;
	readonly description: string;
	readonly confirmLabel: string;
}

/**
 * The members, each with Remove where `mayRemove` allows, which asks first.
 * `onRemove` fails to keep the dialog open, showing `error`. `label`,
 * `description` and `action` head the group, as a settings group's do.
 */
export function MemberRows({
	label,
	description,
	action,
	workspaceId,
	members,
	emptyLabel,
	mayRemove,
	removeLabel,
	confirmation,
	onRemove,
	pending,
	error,
}: {
	label?: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	workspaceId: string;
	members: { data?: readonly ListedMember[]; isError: boolean; error: unknown };
	/** Said when there is nobody. */
	emptyLabel: string;
	mayRemove: (member: ListedMember) => boolean;
	/** The Remove button's name for `member`. */
	removeLabel: (member: ListedMember) => string;
	confirmation: (member: ListedMember) => Confirmation;
	onRemove: (member: ListedMember) => Promise<unknown>;
	pending: boolean;
	error: unknown;
}) {
	const memberships = useMemberships(workspaceId);
	const session = useSession();
	const [removing, setRemoving] = useState<ListedMember>();
	const roleOf = (memberId: string) =>
		memberships.data?.find((membership) => membership.member.id === memberId)?.role;
	const asked = removing && confirmation(removing);

	async function remove(member: ListedMember) {
		try {
			await onRemove(member);
		} catch {
			return;
		}
		setRemoving(undefined);
	}

	let rows: ReactNode;
	if (members.isError) {
		rows = <SettingsRowAlert>{failureMessage(members.error)}</SettingsRowAlert>;
	} else if (members.data?.length === 0) {
		rows = <SettingsRow label={emptyLabel} />;
	} else {
		rows = members.data?.map((member) => (
			<SettingsRow
				key={member.memberId}
				icon={<MemberAvatar member={member} size={24} />}
				label={member.name}
				trailing={
					<>
						<SettingsValue>
							{member.memberId === session.member?.id
								? "You"
								: // Said once the workspace roster has answered, not guessed before it.
									memberships.data && workspaceRoleLabel(roleOf(member.memberId))}
						</SettingsValue>
						{mayRemove(member) && (
							<IconButton
								variant="destructive"
								label={removeLabel(member)}
								disabled={pending}
								onClick={() => setRemoving(member)}
							>
								<Minus size={13} strokeWidth={2.6} />
							</IconButton>
						)}
					</>
				}
			/>
		));
	}

	return (
		<SettingsGroup label={label} description={description} action={action}>
			{rows}
			<DeleteDialog
				open={removing !== undefined}
				onOpenChange={(open) => {
					if (!open) setRemoving(undefined);
				}}
				title={asked?.title ?? ""}
				description={asked?.description ?? ""}
				confirmLabel={asked?.confirmLabel}
				pending={pending}
				error={error ? failureMessage(error) : undefined}
				onDelete={async () => {
					if (removing) await remove(removing);
				}}
			/>
		</SettingsGroup>
	);
}

/**
 * Add members, beside a members list's title: a menu of the workspace's
 * members not in it yet, each added as they are picked. Why an add failed is
 * said under the button.
 */
export function AddMembersMenu({
	workspaceId,
	present,
	onAdd,
	pending,
	error,
}: {
	workspaceId: string;
	/** Who is in it already, whom the menu leaves out. */
	present: readonly ListedMember[] | undefined;
	onAdd: (memberId: string) => void;
	pending: boolean;
	error: unknown;
}) {
	const memberships = useMemberships(workspaceId);
	const inIt = new Set(present?.map((member) => member.memberId));
	const addable = memberships.data?.filter((membership) => !inIt.has(membership.member.id)) ?? [];
	return (
		<div className="flex flex-col items-end gap-2">
			<DropdownMenu>
				<SettingsAddButton disabled={pending} render={<DropdownMenuTrigger />}>
					Add members
				</SettingsAddButton>
				<DropdownMenuContent align="end" className="min-w-52">
					{memberships.isPending ? (
						<DropdownMenuItem disabled>Loading…</DropdownMenuItem>
					) : addable.length === 0 ? (
						<DropdownMenuItem disabled>Everyone in the workspace is here.</DropdownMenuItem>
					) : (
						addable.map((membership) => (
							<DropdownMenuItem
								key={membership.member.id}
								onClick={() => onAdd(membership.member.id)}
							>
								{/* Hidden from the name, or the initials would read as part of it. */}
								<span aria-hidden>
									<MemberAvatar member={membership.member} size={22} />
								</span>
								<span className="min-w-0 flex-1 truncate">{membership.member.name}</span>
							</DropdownMenuItem>
						))
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{error ? <Alert>{failureMessage(error)}</Alert> : null}
		</div>
	);
}
