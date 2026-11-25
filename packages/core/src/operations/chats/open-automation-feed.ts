import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesAutomation } from "../../proofs/reaches-automation.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const openAutomationFeed = defineOperation(
	chatsContracts["chats.openAutomationFeed"],
	(principal, input) =>
		Effect.gen(function* () {
			const chats = yield* Chats.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(
				principal,
				workspaceId,
				input.automationId,
				(principal, workspace, automation) =>
					Effect.gen(function* () {
						const reach = yield* proveReachesAutomation(principal, workspace, automation);
						return yield* chats.openAutomationFeed(automation, reach);
					}),
			);
		}),
);
