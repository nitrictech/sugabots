import type { ToolApprovalConflict } from "@sugabots/contracts/errors/approvals";
import type { ActionForbidden } from "@sugabots/contracts/errors/proofs";
import { approvalsContracts } from "@sugabots/contracts/operations/approvals";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { ComputerNetwork } from "../../computers/computer-network.ts";
import { proveCanDecide } from "../../proofs/can-decide.ts";
import { proveIsMember } from "../../proofs/is-member.ts";
import { named } from "../../proofs/proof.ts";
import { defineOperation } from "../operation.ts";

/**
 * Deciding a call that waits for approval. Allowing a request to change a
 * computer, such as a host request, makes the change with the approver's own
 * authority, in the decision's transaction; the turn then reads what became
 * of it.
 */
export const makeDecide = <R>(
	checkApprovalPermission: (
		member: string,
		call: Turns.ApprovalCall,
		executionNumber: number,
	) => Effect.Effect<ToolApprovalConflict["reason"], ActionForbidden, R>,
) =>
	defineOperation(approvalsContracts["approvals.decide"], (principal, input) =>
		named(principal, input.toolCallId, (principal, call) =>
			Effect.gen(function* () {
				const isMember = yield* proveIsMember(principal);
				const canDecide = yield* proveCanDecide(isMember, call);
				const controls = yield* Turns.Controls;
				const network = yield* ComputerNetwork.Service;
				return yield* controls.decide(
					isMember,
					canDecide,
					input.approvalId,
					input.decision,
					(approver, call, executionNumber) =>
						approver.rule === "computerRequest"
							? network.grantHostRequest(isMember, approver).pipe(
									Effect.as(undefined),
									Effect.catchTags({
										NoComputerProvider: () => Effect.succeed("noComputerProvider" as const),
										ApprovalRefused: () => Effect.succeed("computerUseChanged" as const),
										ComputerHostBlocked: () => Effect.succeed("hostBlocked" as const),
									}),
								)
							: checkApprovalPermission(isMember.member, call, executionNumber),
				);
			}),
		),
	);
