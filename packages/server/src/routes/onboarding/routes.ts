import { BadRequest, CurrentUser } from "@sugabots/contracts/http";
import type { OnboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";

/** Whether the signed-in person has finished setting up, and marking that they have. */
export interface OnboardingRoutesOptions {
	onboarding: OnboardingStore;
}

export function onboardingRoutes({ onboarding }: OnboardingRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "onboarding", (handlers) =>
		handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					return { completed: yield* onboarding.isCompleted(user.id) };
				}),
			)
			.handle("complete", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const { workspaceId, podId, agentId } = payload;
					if (!(yield* onboarding.complete(user.id, workspaceId, podId, agentId))) {
						return yield* new BadRequest({ message: "Finish creating your pod and agent first" });
					}
					return { completed: true };
				}),
			)
			.handle("completeInvite", ({ payload }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const workspaceId = yield* onboarding.completeAcceptedInvite(
						user.id,
						payload.invitationId,
					);
					if (!workspaceId) {
						return yield* new BadRequest({
							message: "The invitation has not been accepted by this account",
						});
					}
					return { workspaceId };
				}),
			),
	);
}
