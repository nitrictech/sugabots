import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { connectorsContracts } from "@sugabots/contracts/operations/connectors";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveConnectorCall } from "../../proofs/connector-call.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesChat } from "../../proofs/reaches-chat.ts";
import { proveRunsTurn } from "../../proofs/runs-turn.ts";
import { ConnectorCalls } from "../../providers/connectors/connector-calls.ts";
import { defineOperation } from "../operation.ts";

export const callTool = defineOperation(
	connectorsContracts["connectors.callTool"],
	(principal, input, call) =>
		Effect.gen(function* () {
			if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun")
				return yield* new ResourceHidden({ resource: "connector" });
			const calls = yield* ConnectorCalls.Service;
			return yield* named(
				principal,
				principal.turn,
				input.connectorId,
				call,
				(acting, turn, connector, calling) =>
					named(principal.chat, input, (chat, approvedInput) =>
						Effect.gen(function* () {
							const running = yield* proveRunsTurn(yield* proveReachesChat(acting, chat), turn);
							const described = calls.described(principal, input.connectorId, input.tool);
							if (!described && calling.value.kind === "approvalCheck")
								return yield* new ResourceHidden({ resource: "connector" });
							const { use, approved } = yield* proveConnectorCall(
								running,
								connector,
								calling,
								approvedInput,
								described && {
									revision: described.connectorRevision,
									described: described.described,
								},
							);
							if (!described) return yield* new ResourceHidden({ resource: "connector" });
							if (use.writeOrDelete) {
								const records = yield* Turns.Records.Service;
								yield* records.markActed(running);
							}
							return yield* calls.callTool(running, use, approved);
						}),
					),
			);
		}),
);
