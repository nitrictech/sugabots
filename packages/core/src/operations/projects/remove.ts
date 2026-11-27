import { projectsContracts } from "@sugabots/contracts/operations/projects";
import { Effect } from "effect";
import { Turns } from "../../chats/turns/turns.ts";
import { proveCanDeleteProject } from "../../proofs/project-permissions.ts";
import { named } from "../../proofs/proof.ts";
import { proveReachesProject } from "../../proofs/reaches-project.ts";
import { Projects } from "../../workspaces/projects/projects.ts";

import { finishDeletion } from "../finish-deletion.ts";
import { defineOperation } from "../operation.ts";
import { underProjectsLock } from "./locking.ts";

export const remove = defineOperation(projectsContracts["projects.remove"], (principal, input) =>
	Effect.gen(function* () {
		const withdrawals = yield* Turns.ApprovalWithdrawals.Service;
		const projects = yield* Projects.Service;
		const removing = yield* underProjectsLock(principal, input.projectId, (lock) =>
			named(input.projectId, (project) =>
				Effect.gen(function* () {
					const reach = yield* proveReachesProject(lock.principal, project, true);
					return yield* projects.beginRemoval(yield* proveCanDeleteProject(lock, reach));
				}),
			).pipe(Effect.tap(() => withdrawals.afterDeletionStarts(lock))),
		);
		yield* finishDeletion(principal, removing.workspaceId, {
			kind: "project",
			id: removing.projectId,
		});
	}),
);
