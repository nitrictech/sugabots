import { chatsContracts } from "@sugabots/contracts/operations/chats";
import { Effect } from "effect";
import { Chats } from "../../chats/chats/chats.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const openAutomationFeed = defineOperation(
	chatsContracts["chats.openAutomationFeed"],
	(principal, input) =>
		Effect.gen(function* () {
			const chats = yield* Chats.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					// The automation is found among those whose projects the principal reaches.
					const reach = proveReachSet(yield* proveInWorkspace(principal, workspace));
					return yield* chats.openAutomationFeed(reach, input.automationId);
				}),
			);
		}),
);
