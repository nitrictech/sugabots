import { Effect } from "effect";
import type { Principal } from "../../principal.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { proveRunsTurn, type RunsTurn } from "../../proofs/runs-turn.ts";

/**
 * Names the turn `input.turnId` and its chat, proves that `principal` runs
 * the turn, and runs `use` with that proof: the one check every one of the
 * loop's own records but ending a lost turn makes.
 */
export const asRunningTurn = <A, E, R>(
	principal: Principal,
	input: { readonly chatId: string; readonly turnId: string },
	use: <P, T>(runsTurn: RunsTurn<P, T>) => Effect.Effect<A, E, R>,
) =>
	named(principal, input.chatId, input.turnId, (principal, chat, turn) =>
		Effect.gen(function* () {
			const reach = yield* proveReachesChat(principal, chat);
			const runsTurn = yield* proveRunsTurn(reach, turn);
			return yield* use(runsTurn);
		}),
	);
