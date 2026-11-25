import { turnsContracts } from "@sugabots/contracts/operations/turns";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveEndsTurn } from "../../proofs/ends-turn.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

export const endLost = defineOperation(turnsContracts["turns.endLost"], (principal, input) =>
	Effect.gen(function* () {
		const records = yield* Turns.Records.Service;
		return yield* named(principal, input.turnId, (principal, turn) =>
			Effect.gen(function* () {
				const endsTurn = yield* proveEndsTurn(principal, turn);
				return yield* records.endLost(endsTurn, input.ending);
			}),
		);
	}),
);
