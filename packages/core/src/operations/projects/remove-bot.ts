import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanChangeProjectMembers } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";

import { defineOperation } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

export const removeBot = defineOperation(
	projectsContracts["projects.removeBot"],
	(principal, input) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			return yield* underProjectsLock(principal, input.projectId, (lock) =>
				named(input.projectId, input.botId, (project, bot) =>
					Effect.gen(function* () {
						const canChange = yield* proveCanChangeProjectMembers(
							lock,
							yield* proveReachesProject(lock.principal, project),
						);
						return yield* projects.removeBot(canChange, bot);
					}),
				),
			);
		}),
);
