import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import type { Principal } from "../../principal.ts";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { checkProjectJoin, proveCanJoinProject } from "../../proofs/can-join-project.ts";
import { type Named, named } from "../../proofs/proof.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation, unexpectedApprovalProof } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

export const join = defineOperation(projectsContracts["projects.join"], (principal, input, call) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* named(input.projectId, call, input, (project, call, approvedInput) => {
			const approveJoin = <P>(principal: Named<P, Principal>) =>
				proveApproved(principal, call, approvalRule("projects.join"), approvedInput, project);

			if (call.value.kind === "approvalCheck") {
				return named(principal, (principal) =>
					checkProjectJoin(principal.value, project.value).pipe(
						Effect.andThen(approveJoin(principal)),
						Effect.andThen(unexpectedApprovalProof),
					),
				);
			}
			return underProjectsLock(principal, input.projectId, (lock) =>
				Effect.gen(function* () {
					const canJoin = yield* proveCanJoinProject(lock, project);
					const approved = yield* approveJoin(lock.principal);
					return yield* projects.join(lock, canJoin, approved);
				}),
			);
		});
	}),
);
