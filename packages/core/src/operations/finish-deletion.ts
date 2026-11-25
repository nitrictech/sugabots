import { Effect } from "effect";
import { ProjectComputers } from "../computers/project-computers.ts";
import type { DeletionTarget, Principal } from "../principal.ts";
import {
	proveDeletionRecorded,
	proveProjectDeletionRecorded,
	proveProjectDeletionStarted,
	proveWorkspaceDeletionStarted,
} from "../proofs/deletion-started.ts";
import { named } from "../proofs/proof.ts";
import { underWorkspaceLock } from "../proofs/workspace-lock.ts";
import { Bots } from "../workspaces/bots/bots.ts";
import { Membership } from "../workspaces/membership/membership.ts";
import { Projects } from "../workspaces/projects/projects.ts";

export const finishDeletion = (principal: Principal, workspaceId: string, target: DeletionTarget) =>
	Effect.gen(function* () {
		const computers = yield* ProjectComputers.Service;
		// The committed intent authorizes the deletion. The member who recorded it
		// may have lost their role or session before either of these steps runs.
		if (target.kind === "workspace") {
			const membership = yield* Membership.Service;
			yield* named(workspaceId, (workspace) =>
				Effect.flatMap(proveDeletionRecorded(workspace), (recorded) =>
					recorded ? computers.destroyAllIn(recorded) : Effect.void,
				),
			);
			return yield* underWorkspaceLock(
				principal,
				workspaceId,
				(lock) =>
					Effect.gen(function* () {
						const proof = yield* proveWorkspaceDeletionStarted(lock);
						if (proof) yield* membership.delete(proof);
					}),
				{ allowDeleting: true },
			);
		}
		yield* named(workspaceId, target.id, (workspace, project) =>
			Effect.flatMap(proveProjectDeletionRecorded(workspace, project), (recorded) =>
				recorded ? computers.destroy(recorded) : Effect.void,
			),
		);
		yield* underWorkspaceLock(
			principal,
			workspaceId,
			(lock) =>
				named(target.id, (project) =>
					Effect.gen(function* () {
						const proof = yield* proveProjectDeletionStarted(lock, project);
						if (!proof) return;
						switch (proof.targetKind) {
							case "bot":
								return yield* (yield* Bots.Service).remove(proof);
							case "membership":
								return yield* (yield* Membership.Service).finishRemoval(proof);
							case "project":
								return yield* (yield* Projects.Service).remove(proof);
						}
					}),
				),
			{ allowDeleting: true },
		);
	});
