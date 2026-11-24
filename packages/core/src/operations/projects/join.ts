import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanJoinProject } from "../../proofs/can-join-project.ts";
import { named } from "../../proofs/proof.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const join = defineOperation(projectsContracts["projects.join"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* named(principal, input.projectId, (principal, project) =>
			Effect.flatMap(proveCanJoinProject(principal, project), projects.join),
		);
	}),
);
