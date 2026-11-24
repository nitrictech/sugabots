import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanChangeProjectSettings } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";

export const update = defineOperation(projectsContracts["projects.update"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		const { leadBotId, ...changes } = input.changes;
		return yield* named(principal, input.projectId, (principal, project) =>
			Effect.gen(function* () {
				const canChange = yield* proveCanChangeProjectSettings(
					yield* proveReachesProject(principal, project),
				);
				if (leadBotId === undefined) return yield* projects.update(canChange, changes, undefined);
				// A new lead the member can't reach is answered as if it weren't there.
				return yield* named(leadBotId, (leadBot) =>
					Effect.flatMap(proveReachesBot(principal, leadBot), (lead) =>
						projects.update(canChange, changes, lead),
					),
				);
			}),
		);
	}),
);
