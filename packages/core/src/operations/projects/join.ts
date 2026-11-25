import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanJoinProject } from "../../proofs/can-join-project.ts";
import { named } from "../../proofs/proof.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

export const join = defineOperation(projectsContracts["projects.join"], (principal, input, call) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* underProjectsLock(principal, input.projectId, (lock) =>
			named(input.projectId, call, input, (project, call, approvedInput) =>
				Effect.gen(function* () {
					const canJoin = yield* proveCanJoinProject(lock, project);
					const approved = yield* proveApproved(
						lock.principal,
						call,
						approvalRule("projects.join"),
						approvedInput,
						project,
					);
					return yield* projects.join(canJoin, approved);
				}),
			),
		);
	}),
);
