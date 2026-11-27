import type { InputOf } from "@sugabots/contracts/operations";
import { Effect } from "effect";
import type { OfferedTool } from "../chats/tools/connector-catalog.ts";
import { Turns } from "../chats/turns/turns.ts";
import { transaction } from "../database/database.ts";
import type { Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { proveConnectorApproved } from "./approved.ts";
import { proveCanUseChatComputer } from "./can-use-computer.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
import { type Named, named } from "./proof.ts";
import type { RunsTurn } from "./runs-turn.ts";

export const proveConnectorCall = <P, T, K, X, I>(
	running: RunsTurn<P, T>,
	connector: Named<K, string>,
	calling: Named<X, Call>,
	input: Named<I, InputOf<"connectors.callTool">>,
	listed:
		| (NonNullable<Parameters<typeof proveCanUseConnector>[3]> & {
				usesComputer: boolean;
				resolveApprovalTargets?: OfferedTool["resolveApprovalTargets"];
		  })
		| undefined,
) =>
	transaction(
		Effect.gen(function* () {
			yield* Turns.holdTurnForToolWrite(running);
			const acting: Named<P, Principal> = running.principal;
			const use = yield* proveCanUseConnector(acting, connector, input.value.tool, listed);
			const principal = acting.value;
			const resolveTargets = listed?.resolveApprovalTargets?.(input.value.arguments);
			const approved =
				listed?.usesComputer &&
				(principal._tag === "BotForAsker" || principal._tag === "AutomationRun")
					? yield* named(principal.chat, (chat) =>
							Effect.flatMap(proveCanUseChatComputer(acting, chat), (computerUse) =>
								proveConnectorApproved(acting, calling, input, running.turn, use, {
									computerUse,
									resolveTargets,
								}),
							),
						)
					: yield* proveConnectorApproved(acting, calling, input, running.turn, use, {
							resolveTargets,
						});
			return { use, approved };
		}),
	);
