import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { readingUnderWorkspaceShare } from "../../proofs/workspace-lock.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { workspaceOfProject } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const listMembers = defineOperation(
	projectsContracts["projects.listMembers"],
	(principal, input) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				readingUnderWorkspaceShare(
					workspaceOfProject(project.value),
					"project",
					Effect.flatMap(proveReachesProject(principal, project), projects.members),
				),
			);
		}),
);
