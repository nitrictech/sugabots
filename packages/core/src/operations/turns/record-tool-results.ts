import { turnsContracts } from "@sugabots/contracts/operations/turns";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { defineOperation } from "../operation.ts";
import { asRunningTurn } from "./running-turn.ts";

export const recordToolResults = defineOperation(
	turnsContracts["turns.recordToolResults"],
	(principal, input) =>
		Effect.gen(function* () {
			const records = yield* Turns.Records.Service;
			return yield* asRunningTurn(principal, input, (runsTurn) =>
				records.recordToolResults(runsTurn, input.results),
			);
		}),
);
