import { BadRequest } from "@sugabots/contracts/http";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** Whether the signed-in person has finished setting up, and marking that they have. */
export const onboardingRoutes = HttpApiBuilder.group(ServerApi, "onboarding", (handlers) =>
	Effect.gen(function* () {
		const onboarding = yield* Onboarding.Service;
		return handlers
			.handle("status", () =>
				onboarding.isCompleted.pipe(
					Effect.map((completed) => ({ completed })),
					asSessionUser,
				),
			)
			.handle("complete", ({ payload }) =>
				onboarding
					.complete(payload)
					.pipe(Effect.as({ completed: true }), asSessionUser, asHttpError(onboardingErrors)),
			)
			.handle("completeInvite", ({ payload }) =>
				onboarding.completeAcceptedInvite(payload).pipe(
					Effect.map((workspaceId) => ({ workspaceId })),
					asSessionUser,
					asHttpError(onboardingErrors),
				),
			);
	}),
);

const onboardingErrors = {
	...refusals,
	NotReadyToFinish: BadRequest,
	InvitationNotAccepted: BadRequest,
	ModelNotEnabled: BadRequest,
};
