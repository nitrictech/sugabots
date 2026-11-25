import { Effect } from "effect";
import { ProjectComputers } from "../computers/project-computers.ts";
import type { DeletionTarget, Principal } from "../principal.ts";
import {
	proveProjectDeletionStarted,
	proveWorkspaceDeletionStarted,
} from "../proofs/deletion-started.ts";
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
			yield* computers.destroyAllIn(workspaceId);
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
		yield* computers.destroy({ workspaceId, projectId: target.id });
		yield* underWorkspaceLock(
			principal,
			workspaceId,
			(lock) =>
				Effect.gen(function* () {
					const proof = yield* proveProjectDeletionStarted(lock, target.id);
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
			{ allowDeleting: true },
		);
	});
