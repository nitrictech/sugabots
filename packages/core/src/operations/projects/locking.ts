import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal } from "../../principal.ts";
import { type HoldsWorkspaceLock, underWorkspaceLock } from "../../proofs/workspace-lock.ts";
import { workspaceOfProject } from "../../workspaces/workspace-reference.ts";

/**
 * Runs `body` under the lock of the project `projectId`'s workspace, as every
 * change to who is in a project does: the project, and whoever or whatever
 * the change is about, are named afresh inside it. A project that isn't there
 * is hidden.
 */
export const underProjectsLock = <A, E, R>(
	principal: Principal,
	projectId: string,
	body: <P, W>(lock: HoldsWorkspaceLock<P, W>) => Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const workspaceId = yield* workspaceOfProject(projectId);
		if (workspaceId === undefined) return yield* new ResourceHidden({ resource: "project" });
		return yield* underWorkspaceLock(principal, workspaceId, body);
	});
