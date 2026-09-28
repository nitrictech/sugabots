import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/**
 * A model that cannot be reached is a failed case in the report, not a failed
 * request — that is the answer somebody asked for. A defect here is ours, and
 * answers 500.
 */
export const modelTrialRoutes = HttpApiBuilder.group(ServerApi, "modelTrials", (handlers) =>
	Effect.gen(function* () {
		const trials = yield* ModelTrials.Service;
		return handlers.handle("run", ({ params, payload }) =>
			trials
				.run({ workspace: params.workspace, ...payload })
				.pipe(asSessionUser, asHttpError(refusals)),
		);
	}),
);
