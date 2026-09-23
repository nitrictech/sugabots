import { runTrial } from "@sugabots/core/conversations/model-trials/trial";
import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";

export interface ModelTrialRoutesOptions {
	model: TurnModel;
}

/**
 * A model that cannot be reached is a failed case in the report, not a failed
 * request — that is the answer somebody asked for. A defect here is ours, and
 * answers 500.
 */
export function modelTrialRoutes({ model }: ModelTrialRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "modelTrials", (handlers) =>
		handlers.handle("run", ({ payload }) =>
			Effect.flatMap(grantedWorkspace, ({ workspaceId }) =>
				runTrial(
					{ systemAgentKey: payload.systemAgentKey, model: payload.model, workspaceId },
					model,
				),
			),
		),
	);
}
