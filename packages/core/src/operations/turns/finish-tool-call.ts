import { turnsContracts } from "@sugabots/contracts/operations/turns";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { defineOperation } from "../operation.ts";
import { asRunningTurn } from "./running-turn.ts";

export const finishToolCall = defineOperation(
	turnsContracts["turns.finishToolCall"],
	(principal, input) =>
		Effect.gen(function* () {
			const records = yield* Turns.Records.Service;
			return yield* asRunningTurn(principal, input, (runsTurn) =>
				records.finishToolCall(runsTurn, input.callId, input.outcome),
			);
		}),
);
