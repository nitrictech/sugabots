import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanChangeProjectMembers } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const addBot = defineOperation(projectsContracts["projects.addBot"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		return yield* named(principal, input.projectId, input.botId, (principal, project, bot) =>
			Effect.gen(function* () {
				const canChange = yield* proveCanChangeProjectMembers(
					yield* proveReachesProject(principal, project),
				);
				// A bot the member can't reach is answered as if it weren't there.
				const reachesBot = yield* proveReachesBot(principal, bot);
				return yield* projects.addBot(canChange, reachesBot);
			}),
		);
	}),
);
