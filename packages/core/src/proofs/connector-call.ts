import { Effect } from "effect";
import { Turns } from "../chats/turns/turns.ts";
import { transaction } from "../database/database.ts";
import type { Call } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { approvalRule, proveApproved } from "./approved.ts";
import { proveCanUseConnector } from "./can-use-connector.ts";
import type { Named } from "./proof.ts";
import type { RunsTurn } from "./runs-turn.ts";

const rule = approvalRule("connectors.callTool");

export const proveConnectorCall = <P, T, K, X>(
	running: RunsTurn<P, T>,
	connector: Named<K, string>,
	calling: Named<X, Call>,
	tool: string,
	args: Record<string, unknown>,
	listed: Parameters<typeof proveCanUseConnector>[3],
) =>
	transaction(
		Effect.gen(function* () {
			yield* Turns.holdTurnForToolWrite(running);
			const acting: Named<P, Principal> = running.principal;
			const use = yield* proveCanUseConnector(acting, connector, tool, listed);
			const approved = yield* proveApproved(acting, calling, rule, args, use);
			return { use, approved };
		}),
	);
