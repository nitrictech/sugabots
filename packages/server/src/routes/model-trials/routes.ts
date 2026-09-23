import { newModelTrialSchema } from "@sugabots/contracts";
import { runTrial } from "@sugabots/core/conversations/model-trials/trial";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Effect } from "effect";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

/**
 * Trying a model on a system agent before the workspace relies on it.
 *
 * Admin only, like choosing a provider: it spends model calls, and it decides
 * what the workspace's unattended agents will run on.
 */
export interface ModelTrialRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	model: TurnModel;
}

export function createModelTrialRoutes({
	resolveSession,
	authorization,
	run,
	model,
}: ModelTrialRoutesOptions) {
	const session = requireSession(resolveSession);
	const managesProviders = requireWorkspace(authorization, run, "workspace.providers.manage");

	return new Hono<AuthEnv>().post(
		"/workspaces/:workspaceId/model-trials",
		session,
		managesProviders,
		body(newModelTrialSchema),
		async (c) => {
			const { systemAgentKey, model: chosen } = c.req.valid("json");
			const workspaceId = c.get("workspace").workspaceId;
			return c.json(
				await run(
					runTrial({ systemAgentKey, model: chosen, workspaceId }, model).pipe(
						// A model that cannot be reached is a failed case, not a failed
						// request — that is the answer somebody asked for. A defect here
						// is ours.
						Effect.catchDefect(() => new HttpError("internal", "The trial could not be run")),
					),
				),
			);
		},
	);
}
