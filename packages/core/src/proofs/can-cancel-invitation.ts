import type { AssignableWorkspaceRole } from "@sugabots/contracts";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { invitation } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import { proveInWorkspace } from "./in-workspace.ts";
import { managesMembers, mayHandle } from "./membership-changes.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

export interface CanCancelInvitation<P, W, I> extends Proof<"CanCancelInvitation", [P, W, I]> {
	readonly workspace: Named<W, string>;
	readonly invitation: Named<I, string>;
	readonly role: AssignableWorkspaceRole;
}

const CanCancelInvitationProof = defineProof("CanCancelInvitation");

export const proveCanCancelInvitation = <P, W, I>(
	lock: HoldsWorkspaceLock<P, W>,
	invitationId: Named<I, string>,
) =>
	Effect.gen(function* () {
		const { principal, workspace } = lock;
		const hidden = new ResourceHidden({ resource: "invitation" });
		const id = invitationId.value;
		const acting = principal.value;
		if ((acting._tag !== "MemberSession" && acting._tag !== "BotForAsker") || !isUuid(id))
			return yield* hidden;
		const { permissionsOf: actor } = yield* proveInWorkspace(principal, workspace);
		const forbidden = new ActionForbidden({ proof: "CanInvite" });
		if (!actor || !managesMembers(actor)) return yield* forbidden;
		const [pending] = yield* query((db) =>
			db
				.select({ role: invitation.role })
				.from(invitation)
				.where(
					and(
						eq(invitation.id, id),
						eq(invitation.workspaceId, workspace.value),
						eq(invitation.status, "pending"),
					),
				)
				.limit(1),
		);
		if (!pending) return yield* hidden;
		if (!mayHandle(actor, pending.role)) return yield* forbidden;
		const proof: CanCancelInvitation<P, W, I> = CanCancelInvitationProof.prove(
			[principal, workspace, invitationId],
			{ workspace, invitation: invitationId, role: pending.role },
		);
		return proof;
	});
