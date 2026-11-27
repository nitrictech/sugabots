import type { ConnectorToolsUnavailable } from "@sugabots/contracts/errors/connectors";
import { ApprovalRefused } from "@sugabots/contracts/errors/proofs";
import type { InputOf } from "@sugabots/contracts/operations";
import { Effect } from "effect";
import type { OfferedTool } from "../chats/tools/connector-catalog.ts";
import { Turns } from "../chats/turns/turns.ts";
import { transaction } from "../database/database.ts";
import type { Call, ResolvedTargets } from "../operations/operation.ts";
import type { Principal } from "../principal.ts";
import { needsConnectorApprovalTargets, proveConnectorApproved } from "./approved.ts";
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
	listingError?: ConnectorToolsUnavailable,
) =>
	Effect.gen(function* () {
		const acting: Named<P, Principal> = running.principal;
		const proveUse = proveCanUseConnector(acting, connector, input.value.tool, listed);
		const resolve = listed?.resolveApprovalTargets;
		let resolvedTargets: ResolvedTargets | null | undefined;
		const call = calling.value;
		const planning = call.kind === "approvalCheck" && call.deferConnectorTargets;
		if (resolve && !planning) {
			resolvedTargets = null;
			if (yield* needsConnectorApprovalTargets(running.turn.value, call)) {
				const use = yield* proveUse;
				if (use.access === "off") return yield* new ApprovalRefused();
				resolvedTargets = yield* resolve(input.value.arguments);
			}
		}
		return yield* transaction(
			Effect.gen(function* () {
				yield* Turns.holdTurnForToolWrite(running);
				const use = yield* proveUse;
				const principal = acting.value;
				const approved =
					listed?.usesComputer &&
					(principal._tag === "BotForAsker" || principal._tag === "AutomationRun")
						? yield* named(principal.chat, (chat) =>
								Effect.flatMap(proveCanUseChatComputer(acting, chat), (computerUse) =>
									proveConnectorApproved(acting, calling, input, running.turn, use, {
										computerUse,
										resolvedTargets,
									}),
								),
							)
						: yield* proveConnectorApproved(acting, calling, input, running.turn, use, {
								resolvedTargets,
								listingError,
							});
				return { use, approved };
			}),
		);
	});
