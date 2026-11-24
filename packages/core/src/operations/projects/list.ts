import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { proveInWorkspace } from "../../proofs/in-workspace.ts";
import { named } from "../../proofs/proof.ts";
import { proveCanReadWorkspace } from "../../proofs/workspace-permissions.ts";
import { Projects } from "../../workspaces/projects/projects.ts";
import { workspaceIdOf } from "../../workspaces/workspace-reference.ts";
import { defineOperation } from "../operation.ts";

export const list = defineOperation(projectsContracts["projects.list"], (principal, input) =>
	Effect.gen(function* () {
		const projects = yield* Projects.Service;
		const workspaceId = yield* workspaceIdOf(input.workspace);
		return yield* named(principal, workspaceId, (principal, workspace) =>
			Effect.gen(function* () {
				const inWorkspace = yield* proveInWorkspace(principal, workspace);
				const canRead = yield* proveCanReadWorkspace(inWorkspace);
				return yield* projects.list(canRead);
			}),
		);
	}),
);
