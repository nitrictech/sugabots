import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveCanChangeProjectMembers } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { defineOperation } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

export const addBot = defineOperation(
	projectsContracts["projects.addBot"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			return yield* underProjectsLock(principal, input.projectId, (lock) =>
				named(input.projectId, input.botId, call, (project, bot, call) =>
					Effect.gen(function* () {
						const canChange = yield* proveCanChangeProjectMembers(
							lock,
							yield* proveReachesProject(lock.principal, project),
						);
						// A bot the member can't reach is answered as if it weren't there.
						const reachesBot = yield* proveReachesBot(lock.principal, bot);
						const approved = yield* proveApproved(
							lock.principal,
							call,
							approvalRule("projects.addBot"),
							input,
						);
						return yield* projects.addBot(canChange, reachesBot, approved);
					}),
				),
			);
		}),
);
