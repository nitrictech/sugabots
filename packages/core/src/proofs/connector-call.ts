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

/**
 * Proves again what `proveConnectorCall` proved of the call to `tool` before
 * its tool hands the request to the network: the turn still runs and its asker
 * still stands, and the connector is still on for the turn, at the revision it
 * was listed at. Run in the transaction that starts the request, whose locks
 * keep a revocation from committing until the request has gone.
 */
export const recheckConnectorCall = <P, T, K>(
	running: RunsTurn<P, T>,
	connector: Named<K, string>,
	tool: string,
	listed: Parameters<typeof proveCanUseConnector>[3],
) =>
	Effect.gen(function* () {
		yield* Turns.holdTurnForToolWrite(running);
		yield* proveCanUseConnector(running.principal, connector, tool, listed);
	});
