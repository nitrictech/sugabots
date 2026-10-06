import { BadRequest } from "@sugabots/contracts/http";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** The signed-in person finishing setting up a workspace. */
export const onboardingRoutes = HttpApiBuilder.group(ServerApi, "onboarding", (handlers) =>
	Effect.gen(function* () {
		const onboarding = yield* Onboarding.Service;
		return handlers.handle("complete", ({ payload }) =>
			onboarding.complete(payload).pipe(asSessionUser, asHttpError(onboardingErrors)),
		);
	}),
);

const onboardingErrors = {
	...refusals,
	NotReadyToFinish: BadRequest,
	NoModelChosen: BadRequest,
};
