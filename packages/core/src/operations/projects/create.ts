import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesBot } from "../../proofs/reaches-bot.ts";
import { proveCanCreateProjects } from "../../proofs/workspace-permissions.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const create = defineOperation(projectsContracts["projects.create"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		const { workspace: reference, leadBotId, ...details } = input;
		const workspaceId = yield* workspaceIdOf(reference);
		return yield* named(principal, workspaceId, leadBotId, (principal, workspace, leadBot) =>
			Effect.gen(function* () {
				const canCreate = yield* proveCanCreateProjects(
					yield* proveInWorkspace(principal, workspace),
				);
				// A bot the member can't reach is answered as if it weren't there.
				const lead = yield* proveReachesBot(principal, leadBot);
				return yield* projects.create(canCreate, lead, details);
			}),
		);
	}),
);
