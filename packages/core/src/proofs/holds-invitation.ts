import type { AssignableWorkspaceRole } from "@sugabots/contracts";
import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { and, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Accounts } from "../accounts/accounts.ts";
import { query } from "../database/database.ts";
import { invitation, member } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { HoldsWorkspaceLock } from "./workspace-lock.ts";

/**
 * The invitation I is pending, unexpired and addressed to the email of P's
 * account, verified where the server requires members to verify theirs, so P
 * may accept or decline it before being in its workspace. Read again under
 * its workspace's lock (see `HoldsWorkspaceLock`), in the transaction that
 * accepts or declines it. Anything else, an invitation to another workspace
 * than the one locked included, is hidden, so an invitation's id can't be
 * probed for.
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
export const proveHoldsInvitation = <P, W, I>(
	lock: HoldsWorkspaceLock<P, W>,
	invitationId: Named<I, string>,
	accounts: Pick<Accounts.Interface, "requireEmailVerification">,
) =>
	Effect.gen(function* () {
		const { principal } = lock;
		const hidden = new ResourceHidden({ resource: "invitation" });
		const acting = principal.value;
		const id = invitationId.value;
		const workspaceId = lock.workspace.value;
		if (acting._tag !== "MemberSession" || !isUuid(id) || !isUuid(workspaceId)) {
			return yield* Effect.fail(hidden);
		}
		const [held] = yield* query((db) =>
			db
				.select({ workspace: invitation.workspaceId, role: invitation.role })
				.from(invitation)
				.innerJoin(member, eq(member.id, acting.member))
				.where(
					and(
						eq(invitation.id, id),
						eq(invitation.workspaceId, workspaceId),
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
