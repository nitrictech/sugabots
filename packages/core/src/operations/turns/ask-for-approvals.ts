import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { turnsContracts } from "@sugabots/contracts/operations/turns";
import { Effect } from "effect";
import { Turns, WorkAdmission } from "../../chats/turns/turns.ts";
import { defineOperation } from "../operation.ts";
import { asRunningTurn } from "./running-turn.ts";

export const askForApprovals = defineOperation(
	turnsContracts["turns.askForApprovals"],
	(principal, input) =>
		Effect.gen(function* () {
			const records = yield* Turns.Records.Service;
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
				return yield* new ResourceHidden({ resource: "turn" });
			return yield* WorkAdmission.underApprovalAdmission(
				principal.chat,
				principal.workspace,
				(admitted) =>
					asRunningTurn(principal, input, (runsTurn) =>
						admitted
							? records.askForApprovals(runsTurn, input.step, input.approvals, admitted)
							: Effect.succeed({ _tag: "NotWaiting" } as const),
					),
			);
		}),
);
