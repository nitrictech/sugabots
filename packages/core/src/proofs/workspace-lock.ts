import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { type Database, query, Transaction, transaction } from "../database/database.ts";
import { workspace as workspaceTable } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, named, type Proof } from "./proof.ts";

/**
 * The open transaction holds the workspace W's lock, for P, and named both
 * afresh once it had taken it.
 *
 * Operations that change who reaches what (a role, an invitation, a
 * project's or a private bot's members, a bot made private or public or
 * deleted, ownership
 * handed over, someone removed from the workspace) check and write under this
 * one lock, taken by {@link underWorkspaceLock}: their provers demand it, and
 * their writes demand the transaction it holds and proofs about P, which only
 * exists inside it. So no such write runs outside the lock, a proof made
 * before it doesn't fit, and two admins can't each act on a role the other
 * has just changed.
 *
 * The lock is the workspace's row, locked for no key update. Rows that refer
 * to the workspace, such as its chats and projects, can still be added
 * meanwhile. A connector or subscription sign-in shares the workspace lock
 * (see `inWorkspaceUnderMembershipLock`), so a sign-in waits for a departure
 * intent and is refused, or the departure waits for the sign-in and sees it.
 */
export interface HoldsWorkspaceLock<P, W> extends Proof<"HoldsWorkspaceLock", [P, W]> {
	readonly principal: Named<P, Principal>;
	readonly workspace: Named<W, string>;
}

const HoldsWorkspaceLockProof = defineProof("HoldsWorkspaceLock");

/**
 * Runs `body` in one `READ COMMITTED` transaction that first takes the lock
 * of the workspace `workspaceId`, with the principal and the workspace named
 * afresh inside it, and hands it the proof that it holds the lock.
 * `READ COMMITTED` reads each statement afresh, so what `body` reads after the
 * lock is what the change before it committed. A workspace that isn't there
 * has no row to lock; its provers find it hidden.
 *
 * Begins its own transaction, so it may not run inside another: a defect.
 */
export const underWorkspaceLock = <A, E, R>(
	principal: Principal,
	workspaceId: string,
	body: <P, W>(lock: HoldsWorkspaceLock<P, W>) => Effect.Effect<A, E, R>,
	{ allowDeleting = false }: { readonly allowDeleting?: boolean } = {},
): Effect.Effect<A, E | ResourceHidden, Database | Exclude<R, Transaction>> =>
	Effect.gen(function* () {
		if (Option.isSome(yield* Effect.serviceOption(Transaction))) {
			return yield* Effect.die(
				new Error("The workspace's lock begins its own transaction, inside no other"),
			);
		}
		return yield* transaction(
			Effect.gen(function* () {
				yield* query((db) => db.execute(sql`set transaction isolation level read committed`));
				if (isUuid(workspaceId)) {
					const [locked] = yield* query((db) =>
						db
							.select({ deleting: workspaceTable.deleting })
							.from(workspaceTable)
							.where(eq(workspaceTable.id, workspaceId))
							.for("no key update"),
					);
					if (locked?.deleting && !allowDeleting)
						return yield* new ResourceHidden({ resource: "workspace" });
				}
				return yield* named(principal, workspaceId, (principal, workspace) =>
					body(lockOf(principal, workspace)),
				);
			}),
		);
	});

/** The proof that the lock is held, about the values named once it was taken. */
const lockOf = <P, W>(
	principal: Named<P, Principal>,
	workspace: Named<W, string>,
): HoldsWorkspaceLock<P, W> =>
	HoldsWorkspaceLockProof.prove([principal, workspace], { principal, workspace });

export const readCommittedTransaction = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	transaction(
		Effect.andThen(
			query((db) => db.execute(sql`set transaction isolation level read committed`)),
			body,
		),
	);

/**
 * Runs an approval write, parking a call or deciding one, in a transaction
 * that first takes the workspace's row `FOR SHARE`, so it waits for a change
 * to who reaches what and sees it, and is refused in a workspace being
 * deleted. If a transaction is already open, it must use `READ COMMITTED`.
 * The workspace share precedes any turn locks.
 */
export const underWorkspaceShare = <A, E, R>(workspaceId: string, body: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		if (!isUuid(workspaceId)) return yield* new ResourceHidden({ resource: "workspace" });
		const outer = yield* Effect.serviceOption(Transaction);
		const withShare = Option.isSome(outer) ? transaction : readCommittedTransaction;
		return yield* withShare(
			Effect.gen(function* () {
				const [locked] = yield* query((db) =>
					db
						.select({ deleting: workspaceTable.deleting })
						.from(workspaceTable)
						.where(eq(workspaceTable.id, workspaceId))
						.for("share"),
				);
				if (!locked || locked.deleting) return yield* new ResourceHidden({ resource: "workspace" });
				return yield* body;
			}),
		);
	});
