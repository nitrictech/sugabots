import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanLeaveProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const leave = defineOperation(projectsContracts["projects.leave"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* named(principal, input.projectId, (principal, project) =>
			Effect.gen(function* () {
				const canLeave = yield* proveCanLeaveProject(
					yield* proveReachesProject(principal, project),
				);
				return yield* projects.leave(canLeave);
			}),
		);
	}),
);
