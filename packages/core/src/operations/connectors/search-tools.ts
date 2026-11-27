import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { named } from "../../proofs/proof.ts";
import { proveRunsTurn } from "../../proofs/runs-turn.ts";
import { ConnectorCalls } from "../../providers/connectors/connector-calls.ts";
import { defineOperation } from "../operation.ts";

export const searchTools = defineOperation(
	connectorsContracts["connectors.searchTools"],
	(principal, input, call) =>
		Effect.gen(function* () {
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
				return yield* new ResourceHidden({ resource: "turn" });
			const calls = yield* ConnectorCalls.Service;
			return yield* named(
				principal,
				principal.turn,
				call,
				input,
				(acting, turn, calling, approvedInput) =>
					Effect.gen(function* () {
						const running = yield* proveRunsTurn(acting, turn);
						const approved = yield* proveApproved(
							acting,
							calling,
							approvalRule("connectors.searchTools"),
							approvedInput,
							turn,
						);
						return yield* calls.searchTools(running, approved);
					}),
			);
		}),
);
