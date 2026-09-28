import { BadRequest, CurrentUser } from "@sugabots/contracts/http";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { asHttpError } from "../../http/errors.ts";

/** Whether the signed-in person has finished setting up, and marking that they have. */
export const onboardingRoutes = HttpApiBuilder.group(ServerApi, "onboarding", (handlers) =>
	Effect.gen(function* () {
		const onboarding = yield* Onboarding.Service;
		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					return { completed: yield* onboarding.isCompleted(user.id) };
				}),
			)
			.handle("complete", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					yield* onboarding
						.complete({
							userId: user.id,
							workspaceId: payload.workspaceId,
							podId: payload.podId,
							agentId: payload.agentId,
						})
						.pipe(asHttpError(onboardingErrors));
					return { completed: true };
				}),
			)
			.handle("completeInvite", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const workspaceId = yield* onboarding
						.completeAcceptedInvite({ userId: user.id, invitationId: payload.invitationId })
						.pipe(asHttpError(onboardingErrors));
					return { workspaceId };
				}),
			);
	}),
);

const onboardingErrors = {
	NotReadyToFinish: BadRequest,
	InvitationNotAccepted: BadRequest,
	ModelNotEnabled: BadRequest,
};
