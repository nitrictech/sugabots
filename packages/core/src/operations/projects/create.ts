import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { approvalRule, proveApproved } from "../../proofs/approved.ts";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { proveCanCreateProjects } from "../../proofs/workspace-permissions.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

/**
 * Making a project puts its creator, the workspace's owner and admins and its
 * lead in it, so it is proved and made under the workspace's lock, with the
 * lead named afresh there.
 */
export const create = defineOperation(
	projectsContracts["projects.create"],
	(principal, input, call) =>
		Effect.gen(function* () {
			const projects = yield* Projects.Service;
			const { workspace: reference, leadBotId, ...details } = input;
			const workspaceId = yield* workspaceIdOf(reference);
			return yield* underWorkspaceLock(principal, workspaceId, (lock) =>
				named(leadBotId, call, (leadBot, call) =>
					Effect.gen(function* () {
						const canCreate = yield* proveCanCreateProjects(
							yield* proveInWorkspace(lock.principal, lock.workspace),
						);
						// A bot the member can't reach is answered as if it weren't there.
						const lead = yield* proveReachesBot(lock.principal, leadBot);
						const approved = yield* proveApproved(
							lock.principal,
							call,
							approvalRule("projects.create"),
							input,
						);
						return yield* projects.create(lock, canCreate, lead, details, approved);
					}),
				),
			);
		}),
);
