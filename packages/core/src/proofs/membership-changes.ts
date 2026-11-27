import type { AssignableWorkspaceRole, WorkspaceRole } from "@sugabots/contracts";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { type Actor, mayInWorkspace } from "../authorization/permissions.ts";
import { query } from "../database/database.ts";
import { membership } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

/**
 * Changes to who is in a workspace, proved under the workspace's lock (see
 * `HoldsWorkspaceLock`) in the transaction that makes them, so two admins
 * can't each act on a role the other has just changed. Admins manage members
 * but not admins; only the owner makes or removes admins; nobody, the owner
 * included, changes or removes the owner's membership, which changes only by
 * handing over ownership. A bot may only in member bounds, for its asker.
 * The workspace deletion intent takes that same lock, so the ownership
 * check and the decision to delete commit together.
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
 * P is W's owner, and may delete it, proved under its lock in the transaction
 * that records the deletion, so an owner who hands it on first can't commit
 * an intent to delete it.
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
						eq(membership.leaving, false),
					),
				),
		),
		(rows) => new Map(rows.map((row) => [row.member, row.role])),
	);

/** The deciding member as an `Actor`, with their role from `roles`. */
const actorFrom = (deciding: string, roles: ReadonlyMap<string, WorkspaceRole>): Actor => ({
	memberId: deciding,
	workspaceRole: roles.get(deciding),
});

/**
 * Whether `actor`'s role lets them invite members, change their roles and
 * remove them, as far as {@link mayHandle} lets them. `CanInvite`,
 * `CanChangeMembership`.
 */
export function managesMembers(actor: Actor): boolean {
	return mayInWorkspace(actor, "workspace.members.manage");
}

/** Whether `actor` may give or take away the role `role`: admins only by the owner. */
export function mayHandle(actor: Actor, role: WorkspaceRole): boolean {
	return role !== "admin" || mayInWorkspace(actor, "workspace.admins.manage");
}

/** Whether `actor`'s role lets them hand the workspace over. `CanHandOverOwnership`. */
export function handsOverOwnership(actor: Actor): boolean {
	return mayInWorkspace(actor, "workspace.ownership.handOver");
}

/** Whether `actor`'s role lets them delete the workspace. `CanDeleteWorkspace`. */
export function deletesWorkspace(actor: Actor): boolean {
	return mayInWorkspace(actor, "workspace.delete");
}

export const proveCanChangeMembership = <P, W, U>(
	lock: HoldsWorkspaceLock<P, W>,
	memberId: Named<U, string>,
	change: MembershipChange,
) =>
	Effect.gen(function* () {
		const { principal, workspace: workspaceId } = lock;
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
		const roles = yield* rolesIn(workspace, [deciding, target]);
		const actor = actorFrom(deciding, roles);
		const currentRole = roles.get(target);
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!currentRole) return yield* Effect.fail(new ResourceHidden({ resource: "membership" }));
		const allowed =
			managesMembers(actor) &&
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
	lock: HoldsWorkspaceLock<P, W>,
	role: AssignableWorkspaceRole,
) =>
	Effect.gen(function* () {
		const { principal, workspace: workspaceId } = lock;
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		if (!deciding) return yield* Effect.fail(new ActionForbidden({ proof: "CanInvite" }));
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const actor = actorFrom(deciding, yield* rolesIn(workspace, [deciding]));
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!managesMembers(actor) || !mayHandle(actor, role)) {
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
	lock: HoldsWorkspaceLock<P, W>,
	memberId: Named<U, string>,
) =>
	Effect.gen(function* () {
		const { principal, workspace: workspaceId } = lock;
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		const target = memberId.value;
		if (!deciding) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanHandOverOwnership" }));
		}
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!isUuid(target)) return yield* Effect.fail(new ResourceHidden({ resource: "membership" }));
		const roles = yield* rolesIn(workspace, [deciding, target]);
		const actor = actorFrom(deciding, roles);
		const currentRole = roles.get(target);
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!currentRole) return yield* Effect.fail(new ResourceHidden({ resource: "membership" }));
		if (!handsOverOwnership(actor)) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanHandOverOwnership" }));
		}
		const proof: CanHandOverOwnership<P, W, U> = CanHandOverOwnershipProof.prove(
			[principal, workspaceId, memberId],
			{ principal, workspace: workspaceId, member: memberId, currentRole },
		);
		return proof;
	});

export const proveCanLeaveWorkspace = <P, W>(lock: HoldsWorkspaceLock<P, W>) =>
	Effect.gen(function* () {
		const { principal, workspace: workspaceId } = lock;
		const leaving = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		if (!leaving) return yield* Effect.fail(new ActionForbidden({ proof: "CanLeaveWorkspace" }));
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const role = (yield* rolesIn(workspace, [leaving])).get(leaving);
		if (!role) return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const proof: CanLeaveWorkspace<P, W> = CanLeaveWorkspaceProof.prove([principal, workspaceId], {
			principal,
			workspace: workspaceId,
			member: leaving,
			role,
		});
		return proof;
	});

export const proveCanDeleteWorkspace = <P, W>(lock: HoldsWorkspaceLock<P, W>) =>
	Effect.gen(function* () {
		const { principal, workspace: workspaceId } = lock;
		const deciding = memberDeciding(principal.value);
		const workspace = workspaceId.value;
		if (!deciding) return yield* Effect.fail(new ActionForbidden({ proof: "CanDeleteWorkspace" }));
		if (!isUuid(workspace))
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		const actor = actorFrom(deciding, yield* rolesIn(workspace, [deciding]));
		if (!actor.workspaceRole)
			return yield* Effect.fail(new ResourceHidden({ resource: "workspace" }));
		if (!deletesWorkspace(actor)) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanDeleteWorkspace" }));
		}
		const proof: CanDeleteWorkspace<P, W> = CanDeleteWorkspaceProof.prove(
			[principal, workspaceId],
			{ principal, workspace: workspaceId },
		);
		return proof;
	});
