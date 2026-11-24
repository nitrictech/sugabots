import { ResourceHidden, TurnEnded } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, turn } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is the turn T's own principal, whatever it still reaches, and T hasn't
 * ended yet. The bot loop ends a turn that lost its chat through this, once
 * `RunsTurn` refuses.
 */
export interface EndsTurn<P, T> extends Proof<"EndsTurn", [P, T]> {
	readonly principal: Named<P, Principal>;
	readonly turn: Named<T, string>;
}

const EndsTurnProof = defineProof("EndsTurn");

export const proveEndsTurn = <P, T>(principal: Named<P, Principal>, turnId: Named<T, string>) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "turn" });
		const acting = principal.value;
		const id = turnId.value;
		const ownTurn =
			(acting._tag === "BotForAsker" || acting._tag === "AutomationRun") && acting.turn === id;
		if (!ownTurn || !isUuid(id)) return yield* Effect.fail(hidden);
		const [row] = yield* query((db) =>
			db.select({ status: turn.status }).from(turn).where(eq(turn.id, id)).limit(1),
		);
		if (!row) return yield* Effect.fail(hidden);
		if (!(ACTIVE_TURN_STATUSES as readonly string[]).includes(row.status)) {
			return yield* Effect.fail(new TurnEnded());
		}
		const proof: EndsTurn<P, T> = EndsTurnProof.prove([principal, turnId], {
			principal,
			turn: turnId,
		});
		return proof;
	});
