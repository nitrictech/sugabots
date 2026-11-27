import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveCanChangeProjectSettings } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

/**
 * A project's lead is one of its bots, so its settings are proved and changed
 * under its workspace's lock, with the project and a new lead named afresh
 * there.
 */
export const update = defineOperation(projectsContracts["projects.update"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		const { leadBotId, ...changes } = input.changes;
		return yield* underProjectsLock(principal, input.projectId, (lock) =>
			named(input.projectId, (project) =>
				Effect.gen(function* () {
					const canChange = yield* proveCanChangeProjectSettings(
						lock,
						yield* proveReachesProject(lock.principal, project),
					);
					if (leadBotId === undefined) {
						return yield* projects.update(canChange, changes, undefined);
					}
					// A new lead the member can't reach is answered as if it weren't there.
					return yield* named(leadBotId, (leadBot) =>
						Effect.flatMap(proveReachesBot(lock.principal, leadBot), (lead) =>
							projects.update(canChange, changes, lead),
						),
					);
				}),
			),
		);
	}),
);
