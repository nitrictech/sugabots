import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { approvalsContracts } from "@sugabots/contracts/operations/approvals";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { proveCanDecide, workspaceOfApproval } from "../../proofs/can-decide.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { underWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { defineOperation } from "../operation.ts";

/**
 * Deciding a call that waits for approval. Allowing a request to change a
 * computer, such as a host request, makes the change with the approver's own
 * authority, in the decision's transaction; the turn then reads what became
 * of it.
 */
export const decide = defineOperation(approvalsContracts["approvals.decide"], (principal, input) =>
	named(principal, input.toolCallId, (principal, call) =>
		Effect.gen(function* () {
			const isMember = yield* proveIsMember(principal);
			const workspace = yield* workspaceOfApproval(isMember, call.value);
			if (!workspace) return yield* new ResourceHidden({ resource: "approval" });
			const controls = yield* Turns.Controls;
			const network = yield* ComputerNetwork.Service;
			return yield* underWorkspaceShare(
				workspace,
				Effect.gen(function* () {
					const canDecide = yield* proveCanDecide(isMember, call);
					return yield* controls.decide(
						isMember,
						canDecide,
						input.approvalId,
						input.decision,
						(approver) => network.grantHostRequest(isMember, approver),
					);
				}),
			);
		}),
	),
);
