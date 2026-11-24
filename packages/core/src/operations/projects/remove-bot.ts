import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanChangeProjectMembers } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const removeBot = defineOperation(
	projectsContracts["projects.removeBot"],
	(principal, input) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.gen(function* () {
					const canChange = yield* proveCanChangeProjectMembers(
						yield* proveReachesProject(principal, project),
					);
					return yield* projects.removeBot(canChange, input.botId);
				}),
			);
		}),
);
