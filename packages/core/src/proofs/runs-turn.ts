import { ResourceHidden, TurnEnded } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import { turnFacts } from "../authentication/turn-facts.ts";
import { query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES } from "../database/schema.ts";
import type { Principal } from "../principal.ts";
import { turnReachesChat } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";
import type { ReachesChat } from "./reaches-chat.ts";

/**
 * P is the turn T's own principal, still reaches T's chat (for a bot acting
 * for its asker, both the asker and the bot do), and T hasn't ended. What the
 * bot loop records for a turn demands it, so one turn can't write into
 * another, and a turn whose asker or bot lost the chat records nothing more.
 * Each write it guards checks again, in its own SQL, that T hasn't ended and
 * that P's execution of T is still the current one.
 */
export interface RunsTurn<P, T> extends Proof<"RunsTurn", [P, T]> {
	readonly principal: Named<P, Principal>;
	readonly turn: Named<T, string>;
	/** T's chat, and its workspace, which services take from here. */
	readonly chat: string;
	readonly workspace: string;
	/** Which execution of T P is, which each write it guards checks is still the current one. */
	readonly execution: number;
}

const RunsTurnProof = defineProof("RunsTurn");

export const proveRunsTurn = <P, C, T>(reach: ReachesChat<P, C>, turnId: Named<T, string>) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "turn" });
		const { as } = reach;
		const acting = reach.principal.value;
		if (acting._tag !== "BotForAsker" && acting._tag !== "AutomationRun") {
			return yield* Effect.fail(hidden);
		}
		if ((as.kind !== "asker" && as.kind !== "run") || as.turn !== turnId.value) {
			return yield* Effect.fail(hidden);
		}
		const facts = yield* query((db) =>
			Effect.gen(function* () {
				const facts = yield* turnFacts(db, turnId.value);
				return facts && facts.chat === reach.chat.value && (yield* turnReachesChat(db, facts))
					? facts
					: undefined;
			}),
		);
		if (!facts) return yield* Effect.fail(hidden);
		if (!(ACTIVE_TURN_STATUSES as readonly string[]).includes(facts.status)) {
			return yield* Effect.fail(new TurnEnded());
		}
		const proof: RunsTurn<P, T> = RunsTurnProof.prove([reach.principal, turnId], {
			principal: reach.principal,
			turn: turnId,
			chat: facts.chat,
			workspace: facts.workspace,
			execution: acting.executionNumber,
		});
		return proof;
	});
