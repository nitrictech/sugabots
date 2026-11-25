import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { turnsContracts } from "@sugabots/contracts/operations/turns";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { underWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { defineOperation } from "../operation.ts";
import { asRunningTurn } from "./running-turn.ts";

export const askForApprovals = defineOperation(
	turnsContracts["turns.askForApprovals"],
	(principal, input) =>
		Effect.gen(function* () {
			const records = yield* Turns.Records.Service;
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
				return yield* new ResourceHidden({ resource: "turn" });
			return yield* underWorkspaceShare(
				principal.workspace,
				asRunningTurn(principal, input, (runsTurn) =>
					records.askForApprovals(runsTurn, input.step, input.approvals),
				),
			);
		}),
);
