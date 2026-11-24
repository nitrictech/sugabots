import { chatReadsContracts } from "@sugabots/contracts/operations/chat-reads";
import { Effect } from "effect";
import { ChatView } from "../../chats/chats/chat-view.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { proveCanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const approvals = defineOperation(
	chatReadsContracts["chats.approvals"],
	(principal, input) =>
		Effect.gen(function* () {
			const view = yield* ChatView.Service;
			const workspaceId = yield* workspaceIdOf(input.workspace);
			return yield* named(principal, workspaceId, (principal, workspace) =>
				Effect.gen(function* () {
					const inWorkspace = yield* proveInWorkspace(principal, workspace);
					const canRead = yield* proveCanReadWorkspace(inWorkspace);
					return yield* view.approvals(canRead, proveReachSet(inWorkspace));
				}),
			);
		}),
);
