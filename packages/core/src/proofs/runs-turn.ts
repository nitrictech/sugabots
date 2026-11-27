import { ResourceHidden, TurnEnded } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { ACTIVE_TURN_STATUSES, placedChat, turn } from "../database/schema.ts";
import type { Principal } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/** P is an admitted execution of T, which has not ended. Each write checks execution ownership. */
export interface RunsTurn<P, T> extends Proof<"RunsTurn", [P, T]> {
	readonly principal: Named<P, Principal>;
	readonly turn: Named<T, string>;
	/** T's chat, and its workspace, which services take from here. */
	readonly chat: string;
	readonly workspace: string;
	readonly project: string;
	/** Which execution of T P is, which each write it guards checks is still the current one. */
	readonly execution: number;
}

const RunsTurnProof = defineProof("RunsTurn");

export const proveRunsTurn = <P, T>(principal: Named<P, Principal>, turnId: Named<T, string>) =>
	Effect.gen(function* () {
		const acting = principal.value;
		const hidden = new ResourceHidden({ resource: "turn" });
		if (acting._tag !== "BotForAsker" && acting._tag !== "AutomationRun") return yield* hidden;
		if (acting.turn !== turnId.value || (acting.admission === null && acting.executionNumber === 0))
			return yield* hidden;
		const [found] = yield* query((db) =>
			db
				.select({ status: turn.status, project: placedChat.projectId })
				.from(turn)
				.innerJoin(placedChat, eq(placedChat.id, turn.chatId))
				.where(eq(turn.id, acting.turn))
				.limit(1),
		);
		if (!found?.project) return yield* hidden;
		if (!(ACTIVE_TURN_STATUSES as readonly string[]).includes(found.status))
			return yield* new TurnEnded();
		const proof: RunsTurn<P, T> = RunsTurnProof.prove([principal, turnId], {
			principal,
			turn: turnId,
			chat: acting.chat,
			workspace: acting.workspace,
			project: found.project,
			execution: acting.executionNumber,
		});
		return proof;
	});
