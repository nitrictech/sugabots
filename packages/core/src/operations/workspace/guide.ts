import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { workspaceContracts } from "@sugabots/contracts/operations/workspace";
import { Effect } from "effect";
import { WorkspaceGuide } from "../../chats/assistant/workspace-guide.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachSet } from "../../proofs/reach-set.ts";
import { proveCanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { defineOperation } from "../operation.ts";

/**
 * A Personal Assistant's view of its member's workspace: only for a bot in
 * member bounds, whose turn reaches all its member does. To anyone else the
 * workspace as a whole is out of reach.
 */
export const guide = defineOperation(
	workspaceContracts["workspaces.guide"],
	(principal, input, call) =>
		Effect.gen(function* () {
			if (principal._tag !== "BotForAsker" || principal.bounds.kind !== "member") {
				return yield* new ResourceHidden({ resource: "workspace" });
			}
			const guides = yield* WorkspaceGuide.Service;
			return yield* named(
				principal,
				principal.workspace,
				call,
				input,
				(principal, workspace, call, approvedInput) =>
					Effect.gen(function* () {
						const inWorkspace = yield* proveInWorkspace(principal, workspace);
						const canRead = yield* proveCanReadWorkspace(inWorkspace);
						const approved = yield* proveApproved(
							principal,
							call,
							approvalRule("workspaces.guide"),
							approvedInput,
							workspace,
						);
						return yield* guides.guide(canRead, proveReachSet(inWorkspace), approved);
					}),
			);
		}),
);
