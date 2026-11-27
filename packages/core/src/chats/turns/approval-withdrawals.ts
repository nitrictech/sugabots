export * as ApprovalWithdrawals from "./approval-withdrawals.ts";

import { userText } from "@sugabots/errors";
import { and, asc, eq, exists, isNull, type SQL, sql } from "drizzle-orm";
import { Context, DateTime, Duration, Effect, Layer } from "effect";
import { turnFacts } from "../../authentication/turn-facts.ts";
import { type Database, query, transaction } from "../../database/database.ts";
import { chat, toolCall, turn } from "../../database/schema.ts";
import type { DoesStoredWork } from "../../proofs/does-stored-work.ts";
import { turnReachesChat } from "../../proofs/facts.ts";
import type { HoldsWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { awaitsDecisions } from "./lifecycle.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";

export interface Interface {
	readonly afterReachChange: <P, W>(
		lock: HoldsWorkspaceLock<P, W>,
	) => Effect.Effect<void, never, Database>;
	readonly expire: <P, X>(
		work: DoesStoredWork<P, X, "approvalExpiry">,
	) => Effect.Effect<void, never, Database>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ApprovalWithdrawals",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const turns = yield* TurnStore.Service;
	const signals = yield* TurnSignals.Service;

	const withdraw = (
		turnId: string,
		request: "lost_reach" | "approval_expired",
		stillApplies: Effect.Effect<boolean, never, Database>,
	) =>
		transaction(
			Effect.gen(function* () {
				const [waiting] = yield* query((db) =>
					db
						.select({
							status: turn.status,
							endRequested: turn.endRequested,
							executionId: turn.executionId,
						})
						.from(turn)
						.where(eq(turn.id, turnId))
						.for("update"),
				);
				if (!waiting?.executionId || !awaitsDecisions(waiting) || !(yield* stillApplies)) return;
				yield* turns.withdrawApprovals(turnId, request, WITHDRAWN[request]);
				yield* signals.cancel(waiting.executionId);
			}),
		);

	return Service.of({
		afterReachChange: (lock) =>
			Effect.gen(function* () {
				const waiting = yield* query((db) =>
					db
						.select({ id: turn.id })
						.from(turn)
						.innerJoin(chat, eq(chat.id, turn.chatId))
						.where(
							and(
								eq(chat.workspaceId, lock.workspace.value),
								eq(turn.status, "waiting"),
								isNull(turn.endRequested),
								exists(
									db
										.select({ id: toolCall.id })
										.from(toolCall)
										.where(
											and(eq(toolCall.turnId, turn.id), eq(toolCall.approvalStatus, "pending")),
										),
								),
							),
						)
						// Each turn and its calls in turn, in the lock order (see `TurnStore`'s `lockedTurn`).
						.orderBy(asc(turn.botId), asc(turn.id)),
				);
				for (const { id } of waiting) {
					yield* withdraw(id, "lost_reach", lostChat(id));
				}
			}),
		expire: (work) =>
			Effect.gen(function* () {
				const condition = and(
					eq(toolCall.approvalId, work.id.value),
					eq(chat.workspaceId, work.workspace),
				);
				const [due] = yield* dueApprovals(condition);
				if (!due) return;
				yield* withdraw(
					due.turnId,
					"approval_expired",
					Effect.map(dueApprovals(condition), (rows) => rows.length > 0),
				);
			}),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));
export const layer = layerNoDeps.pipe(Layer.provide(TurnStore.layer));

/** What members are told of an approval withdrawn because its turn was asked to end, by why. */
const WITHDRAWN = {
	lost_reach: userText`This approval was withdrawn because the turn lost access to its chat.`,
	approval_expired: userText`This approval expired before anyone decided it.`,
};

const APPROVAL_LIFETIME = Duration.days(7);
const EXPIRY_BATCH_SIZE = 100;

export const approvalCutoff = DateTime.now.pipe(
	Effect.map((now) => DateTime.toDateUtc(DateTime.subtractDuration(now, APPROVAL_LIFETIME))),
);

/** The oldest pending approvals whose decision window has elapsed, optionally narrowed to one subject. */
export const dueApprovals = (condition?: SQL) =>
	Effect.gen(function* () {
		const cutoff = yield* approvalCutoff;
		const askedAt = sql`coalesce(${toolCall.approvalAskedAt}, ${toolCall.startedAt})`;
		return yield* query((db) =>
			db
				.select({ id: toolCall.approvalId, turnId: toolCall.turnId, workspace: chat.workspaceId })
				.from(toolCall)
				.innerJoin(turn, eq(turn.id, toolCall.turnId))
				.innerJoin(chat, eq(chat.id, turn.chatId))
				.where(
					and(
						eq(turn.status, "waiting"),
						isNull(turn.endRequested),
						eq(toolCall.approvalStatus, "pending"),
						sql`${askedAt} <= ${cutoff}`,
						condition,
					),
				)
				.orderBy(askedAt, toolCall.id)
				.limit(EXPIRY_BATCH_SIZE),
		);
	});

const lostChat = (turnId: string) =>
	query((db) =>
		Effect.gen(function* () {
			const facts = yield* turnFacts(db, turnId);
			return !facts || !(yield* turnReachesChat(db, facts));
		}),
	);
