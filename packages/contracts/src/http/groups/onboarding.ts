import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	completedInviteOnboardingSchema,
	completeInviteOnboardingSchema,
	completeOnboardingSchema,
	onboardingStatusSchema,
} from "../../onboarding.ts";
import { Access, Authorise, Session } from "../middleware.ts";

/** Whether the signed-in person has finished setting up, and marking that they have. */
export class OnboardingApi extends HttpApiGroup.make("onboarding")
	.add(
		HttpApiEndpoint.get("status", "/onboarding", {
			success: onboardingStatusSchema,
		}).annotate(Access, { reach: "the signed-in person's own progress" }),
		HttpApiEndpoint.post("complete", "/onboarding/complete", {
			payload: completeOnboardingSchema,
			success: onboardingStatusSchema,
		}).annotate(Access, { reach: "onboarding/store.ts checks the pod and agent named" }),
		HttpApiEndpoint.post("completeInvite", "/onboarding/complete-invite", {
			payload: completeInviteOnboardingSchema,
			success: completedInviteOnboardingSchema,
		}).annotate(Access, { reach: "matches the invitation against this account" }),
	)
	.middleware(Authorise)
	.middleware(Session) {}
