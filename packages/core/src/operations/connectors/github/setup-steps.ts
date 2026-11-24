import type { GitHubSetupOutcome } from "@sugabots/contracts";
import { Effect } from "effect";
import type { Principal } from "../../../principal.ts";
import {
	type CanManageProject,
	proveCanManageProject,
} from "../../../proofs/project-permissions.ts";
import { named } from "../../../proofs/proof.ts";
import { proveReachesProject } from "../../../proofs/reaches-project.ts";
import { GitHubApps } from "../../../providers/connectors/github/github-app.ts";

/**
 * Finishes the setup step `state` was handed out for with `finish`, while
 * the principal still manages its project. A step that is old, altered or
 * another step's, or a project the principal no longer manages, is answered
 * as expired, naming no project, since a browser is reading it.
 */
export const finishSetupStep = (
	principal: Principal,
	state: string | undefined,
	step: GitHubApps.SetupStep["step"],
	finish: <P, J>(
		gitHubApps: GitHubApps.Interface,
		canManage: CanManageProject<P, J>,
		setup: GitHubApps.SetupStep,
	) => Effect.Effect<GitHubSetupOutcome>,
) =>
	Effect.gen(function* () {
		const gitHubApps = yield* GitHubApps.Service;
		const setup = yield* gitHubApps.setupStep(state, step);
		if (!setup) return expired;
		return yield* named(principal, setup.projectId, (principal, project) =>
			Effect.gen(function* () {
				const managing = yield* Effect.result(
					Effect.flatMap(proveReachesProject(principal, project), proveCanManageProject),
				);
				if (managing._tag === "Failure") return expired;
				return yield* finish(gitHubApps, managing.success, setup);
			}),
		);
	});

const expired: GitHubSetupOutcome = { kind: "failed", at: undefined, failure: "expired" };
