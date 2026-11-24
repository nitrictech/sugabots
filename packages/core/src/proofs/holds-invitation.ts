import type { AssignableWorkspaceRole } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Accounts } from "../accounts/accounts.ts";
import { query, Transaction } from "../database/database.ts";
import { invitation, member } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * The invitation I is pending, unexpired and addressed to the email of P's
 * account, verified where the server requires members to verify theirs, so P
 * may accept or decline it before being in its workspace. Read again under
 * the workspace's lock, in the transaction that accepts or declines it.
 * Anything else is hidden, so an invitation's id can't be probed for.
 */
export interface HoldsInvitation<P, I> extends Proof<"HoldsInvitation", [P, I]> {
	readonly principal: Named<P, Principal>;
	readonly invitation: Named<I, string>;
	/** P's member, the account it is addressed to, whom accepting it lets in. */
	readonly member: string;
	/** The workspace it invites P to, which services take from here. */
	readonly workspace: string;
	readonly role: AssignableWorkspaceRole;
}

const HoldsInvitationProof = defineProof("HoldsInvitation");

/** `accounts`: the server's rules for accounts, which say whether the email must be verified. */
export const proveHoldsInvitation = <P, I>(
	principal: Named<P, Principal>,
	invitationId: Named<I, string>,
	accounts: Pick<Accounts.Interface, "requireEmailVerification">,
) =>
	Effect.gen(function* () {
		yield* Transaction;
		const hidden = new ResourceHidden({ resource: "invitation" });
		const acting = principal.value;
		const id = invitationId.value;
		if (acting._tag !== "MemberSession" || !isUuid(id)) return yield* Effect.fail(hidden);
		const [addressed] = yield* query((db) =>
			db
				.select({ workspace: invitation.workspaceId })
				.from(invitation)
				.where(eq(invitation.id, id))
				.limit(1),
		);
		if (!addressed) return yield* Effect.fail(hidden);
		yield* query((db) =>
			db.execute(sql`select lock_project_membership(${addressed.workspace}::uuid)`),
		);
		const [held] = yield* query((db) =>
			db
				.select({ workspace: invitation.workspaceId, role: invitation.role })
				.from(invitation)
				.innerJoin(member, eq(member.id, acting.member))
				.where(
					and(
						eq(invitation.id, id),
						eq(invitation.status, "pending"),
						gt(invitation.expiresAt, sql`now()`),
						eq(invitation.email, sql`lower(${member.email})`),
						accounts.requireEmailVerification ? eq(member.emailVerified, true) : undefined,
					),
				)
				.limit(1)
				// Held until it is accepted, so sending it again or cancelling it waits.
				.for("update", { of: invitation }),
		);
		if (!held) return yield* Effect.fail(hidden);
		const proof: HoldsInvitation<P, I> = HoldsInvitationProof.prove([principal, invitationId], {
			principal,
			invitation: invitationId,
			member: acting.member,
			workspace: held.workspace,
			role: held.role,
		});
		return proof;
	});
