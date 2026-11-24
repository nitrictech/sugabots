import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanDeleteProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const remove = defineOperation(projectsContracts["projects.remove"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* named(principal, input.projectId, (principal, project) =>
			Effect.gen(function* () {
				const canDelete = yield* proveCanDeleteProject(
					yield* proveReachesProject(principal, project),
				);
				return yield* projects.remove(canDelete);
			}),
		);
	}),
);
