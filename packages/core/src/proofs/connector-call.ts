import type { InputOf } from "@sugabots/contracts/operations";
import { Effect } from "effect";
import { Turns } from "../chats/turns/turns.ts";
import { transaction } from "../database/database.ts";
import type { Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { proveConnectorApproved } from "./approved.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
import type { Named } from "./proof.ts";
import type { RunsTurn } from "./runs-turn.ts";

export const proveConnectorCall = <P, T, K, X, I>(
	running: RunsTurn<P, T>,
	connector: Named<K, string>,
	calling: Named<X, Call>,
	input: Named<I, InputOf<"connectors.callTool">>,
	listed: Parameters<typeof proveCanUseConnector>[3],
) =>
	transaction(
		Effect.gen(function* () {
			yield* Turns.holdTurnForToolWrite(running);
			const acting: Named<P, Principal> = running.principal;
			const use = yield* proveCanUseConnector(acting, connector, input.value.tool, listed);
			const approved = yield* proveConnectorApproved(acting, calling, input, running.turn, use);
			return { use, approved };
		}),
	);
