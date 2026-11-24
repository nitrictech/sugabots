import type { AssignableWorkspaceRole, WorkspaceRole } from "@sugabots/contracts";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { type Actor, mayInWorkspace } from "../authorization/permissions.ts";
import { query, Transaction } from "../database/database.ts";
import { membership, workspace as workspaceTable } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * Changes to who is in a workspace, proved under the workspace's lock in the
 * transaction that makes them, so two admins can't each act on a role the
 * other has just changed. Admins manage members but not admins; only the
 * owner makes or removes admins; nobody, the owner included, changes or
 * removes the owner's membership, which changes only by handing over
 * ownership. A bot may only in member bounds, for its asker.
 *
 * The workspace's lock is its row, locked for no key update. Deleting the
 * workspace takes it too, so an owner who hands ownership on meanwhile no
 * longer deletes it, and a subscription sign-in shares it, so a removal waits
 * for one landing for the member it removes. Rows that refer to the
 * workspace, such as its chats and projects, can still be added meanwhile:
 * `lock_project_membership` would hold up a project being made while a
 * removal waits on its member's Personal Assistant's computer at its
 * provider, and a promotion's trigger takes that lock itself.
 */

/** A role to give a member, or their removal from the workspace. */
export type MembershipChange =
	| { readonly kind: "role"; readonly role: AssignableWorkspaceRole }
	| { readonly kind: "removal" };

/** P may make `change` to U's membership of W, which is `currentRole` now. */
export interface CanChangeMembership<P, W, U> extends Proof<"CanChangeMembership", [P, W, U]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
	readonly member: Named<U, string>;
	readonly currentRole: WorkspaceRole;
	readonly change: MembershipChange;
}

/** P may invite someone to W with `role`. */
export interface CanInvite<P, W> extends Proof<"CanInvite", [P, W]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
	readonly role: AssignableWorkspaceRole;
	/** The member inviting: a member signed in, or a bot's asker. */
	readonly inviter: string;
}

/** P is W's owner, and may hand W over to U, who is in W with `currentRole` now. */
export interface CanHandOverOwnership<P, W, U> extends Proof<"CanHandOverOwnership", [P, W, U]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
	readonly member: Named<U, string>;
	readonly currentRole: WorkspaceRole;
}

/**
 * P's member is in W with `role`, and may take themselves out of it. The
 * owner gets this too: the write refuses them, as they stay until they hand
 * ownership over, which is a rule of the workspace's rather than a permission.
 */
export interface CanLeaveWorkspace<P, W> extends Proof<"CanLeaveWorkspace", [P, W]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
	/** The member leaving: a member signed in, or a bot's asker. */
	readonly member: string;
	readonly role: WorkspaceRole;
}

/**
 * P is W's owner, and may delete it, proved under its row's lock in the
 * transaction that deletes it, so an owner who hands ownership on meanwhile
 * no longer deletes it.
 */
export interface CanDeleteWorkspace<P, W> extends Proof<"CanDeleteWorkspace", [P, W]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
}

const CanChangeMembershipProof = defineProof("CanChangeMembership");
const CanInviteProof = defineProof("CanInvite");
const CanHandOverOwnershipProof = defineProof("CanHandOverOwnership");
const CanLeaveWorkspaceProof = defineProof("CanLeaveWorkspace");
const CanDeleteWorkspaceProof = defineProof("CanDeleteWorkspace");

/** The member whose role decides for `principal`: a member signed in, or an asker in member bounds. */
function memberDeciding(principal: Principal): string | undefined {
	if (principal._tag === "MemberSession") return principal.member;
	if (principal._tag === "BotForAsker" && principal.bounds.kind === "member")
		return principal.asker;
	return undefined;
}

/**
 * Locks the workspace's row for no key update, until the enclosing
 * transaction ends. Needs that transaction.
 */
const lockWorkspaceRow = (workspaceId: string) =>
	Effect.gen(function* () {
		yield* Transaction;
		yield* query((db) =>
			db
				.select({ id: workspaceTable.id })
				.from(workspaceTable)
				.where(eq(workspaceTable.id, workspaceId))
				.for("no key update"),
		);
	});

/** `memberIds`' roles in the workspace, by member, read in a statement of its own. */
const rolesIn = (workspaceId: string, memberIds: readonly string[]) =>
	Effect.map(
		query((db) =>
			db
				.select({ member: membership.memberId, role: membership.role })
				.from(membership)
				.where(
					and(
						eq(membership.workspaceId, workspaceId),
						inArray(membership.memberId, [...memberIds]),
					),
				),
		),
		(rows) => new Map(rows.map((row) => [row.member, row.role])),
	);

/**
 * Takes the workspace's lock, which every change to who is in it takes, and
 * reads `memberIds`' roles under it. Needs the transaction the change is made in.
 */
const rolesUnderLock = (workspaceId: string, memberIds: readonly string[]) =>
	Effect.andThen(lockWorkspaceRow(workspaceId), rolesIn(workspaceId, memberIds));

/** The deciding member as an `Actor`, with their role from `roles`. */
const actorFrom = (deciding: string, roles: ReadonlyMap<string, WorkspaceRole>): Actor => ({
	memberId: deciding,
	workspaceRole: roles.get(deciding),
});

/** Whether `actor` may give or take away the role `role`: admins only by the owner. */
function mayHandle(actor: Actor, role: WorkspaceRole): boolean {
	return role !== "admin" || mayInWorkspace(actor, "workspace.admins.manage");
}

export const proveCanChangeMembership = <P, W, U>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
	memberId: Named<U, string>,
	change: MembershipChange,
) =>
	Effect.gen(function* () {
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		const target = memberId.value;
		if (!deciding || !isUuid(workspace) || !isUuid(target)) {
			return yield* Effect.fail(
				deciding
					? new ResourceHidden({ resource: "membership" })
					: new ActionForbidden({ proof: "CanChangeMembership" }),
			);
		}
		const roles = yield* rolesUnderLock(workspace, [deciding, target]);
		const actor = actorFrom(deciding, roles);
		const currentRole = roles.get(target);
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!currentRole) return yield* Effect.fail(new ResourceHidden({ resource: "membership" }));
		const allowed =
			mayInWorkspace(actor, "workspace.members.manage") &&
			currentRole !== "owner" &&
			mayHandle(actor, currentRole) &&
			(change.kind === "removal" || mayHandle(actor, change.role));
		if (!allowed) return yield* Effect.fail(new ActionForbidden({ proof: "CanChangeMembership" }));
		const proof: CanChangeMembership<P, W, U> = CanChangeMembershipProof.prove(
			[principal, workspaceId, memberId],
			{ principal, workspace: workspaceId, member: memberId, currentRole, change },
		);
		return proof;
	});

export const proveCanInvite = <P, W>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
	role: AssignableWorkspaceRole,
) =>
	Effect.gen(function* () {
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		if (!deciding) return yield* Effect.fail(new ActionForbidden({ proof: "CanInvite" }));
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const actor = actorFrom(deciding, yield* rolesUnderLock(workspace, [deciding]));
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!mayInWorkspace(actor, "workspace.members.manage") || !mayHandle(actor, role)) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanInvite" }));
		}
		const proof: CanInvite<P, W> = CanInviteProof.prove([principal, workspaceId], {
			principal,
			workspace: workspaceId,
			role,
			inviter: deciding,
		});
		return proof;
	});

export const proveCanHandOverOwnership = <P, W, U>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
	memberId: Named<U, string>,
) =>
	Effect.gen(function* () {
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		const target = memberId.value;
		if (!deciding) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanHandOverOwnership" }));
		}
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!isUuid(target)) return yield* Effect.fail(new ResourceHidden({ resource: "membership" }));
		const roles = yield* rolesUnderLock(workspace, [deciding, target]);
		const actor = actorFrom(deciding, roles);
		const currentRole = roles.get(target);
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!currentRole) return yield* Effect.fail(new ResourceHidden({ resource: "membership" }));
		if (!mayInWorkspace(actor, "workspace.ownership.handOver")) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanHandOverOwnership" }));
		}
		const proof: CanHandOverOwnership<P, W, U> = CanHandOverOwnershipProof.prove(
			[principal, workspaceId, memberId],
			{ principal, workspace: workspaceId, member: memberId, currentRole },
		);
		return proof;
	});

export const proveCanLeaveWorkspace = <P, W>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
) =>
	Effect.gen(function* () {
		const leaving = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		if (!leaving) return yield* Effect.fail(new ActionForbidden({ proof: "CanLeaveWorkspace" }));
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const role = (yield* rolesUnderLock(workspace, [leaving])).get(leaving);
		if (!role) return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const proof: CanLeaveWorkspace<P, W> = CanLeaveWorkspaceProof.prove([principal, workspaceId], {
			principal,
			workspace: workspaceId,
			member: leaving,
			role,
		});
		return proof;
	});

export const proveCanDeleteWorkspace = <P, W>(
	principal: Named<P, Principal>,
	workspaceId: Named<W, string>,
) =>
	Effect.gen(function* () {
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		if (!deciding) return yield* Effect.fail(new ActionForbidden({ proof: "CanDeleteWorkspace" }));
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const actor = actorFrom(deciding, yield* rolesUnderLock(workspace, [deciding]));
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!mayInWorkspace(actor, "workspace.delete")) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanDeleteWorkspace" }));
		}
		const proof: CanDeleteWorkspace<P, W> = CanDeleteWorkspaceProof.prove(
			[principal, workspaceId],
			{ principal, workspace: workspaceId },
		);
		return proof;
	});
