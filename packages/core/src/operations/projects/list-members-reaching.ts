import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const listMembersReaching = defineOperation(
	projectsContracts["projects.listMembersReaching"],
	(principal, input) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			return yield* named(principal, input.projectId, (principal, project) =>
				Effect.flatMap(proveReachesProject(principal, project), projects.membersReaching),
			);
		}),
);
