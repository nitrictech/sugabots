export * as WorkAdmission from "./work-admission.ts";

import { Context, Effect, Option } from "effect";
import { Transaction } from "../../database/database.ts";
import { readCommittedTransaction } from "../../proofs/workspace-lock.ts";
import { Tier } from "../../tiers.ts";

/**
 * Whether a chat takes more turns and tool calls. Turns asks before it
 * admits work. The answer includes its project and any automation run it is
 * in. Supplied where the chat services are composed.
 */
export type Refusal = "chatUnavailable" | "automationEnded";

export interface Interface {
	/**
	 * Why the chat `chatId` refuses work, if it does. The answer stands until
	 * the caller's transaction ends, so ask before locking the turn or tool
	 * call the work is admitted into.
	 */
	readonly refusal: (chatId: string) => Effect.Effect<Refusal | undefined, never, Transaction>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/WorkAdmission") {
	declare readonly [Tier]: "process";
}

const approvalTransaction: unique symbol = Symbol("ApprovalAdmission");

/** ApprovalAdmission records that its chat accepts work for the rest of the transaction. */
export interface ApprovalAdmission {
	readonly chatId: string;
	readonly [approvalTransaction]: Transaction["Service"];
}

/** underApprovalAdmission checks that chatId takes work before an approval write. */
export const underApprovalAdmission = <A, E, R>(
	chatId: string,
	body: (admitted: ApprovalAdmission | undefined) => Effect.Effect<A, E, R>,
) =>
	readCommittedTransaction(
		Effect.gen(function* () {
			const admission = yield* Service;
			const refused = yield* admission.refusal(chatId);
			const open = yield* Transaction;
			return yield* body(
				refused ? undefined : Object.freeze({ chatId, [approvalTransaction]: open }),
			);
		}),
	);

/** withApprovalAdmission runs a write after checking admission for its chat and transaction. */
export const withApprovalAdmission =
	(admitted: ApprovalAdmission, chatId: string) =>
	<A, E, R>(write: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			const open = yield* Effect.serviceOption(Transaction);
			if (
				admitted?.chatId !== chatId ||
				Option.isNone(open) ||
				admitted[approvalTransaction] !== open.value
			) {
				return yield* Effect.die(
					new Error("Approval admission does not belong to this chat and transaction"),
				);
			}
			return yield* write;
		});
