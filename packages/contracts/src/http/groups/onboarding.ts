import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	completedInviteOnboardingSchema,
	completeInviteOnboardingSchema,
	completeOnboardingSchema,
	onboardingStatusSchema,
} from "../../onboarding.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/** Whether the signed-in person has finished setting up, and marking that they have. */
export class OnboardingApi extends HttpApiGroup.make("onboarding")
	.add(
		HttpApiEndpoint.get("status", "/onboarding", {
			success: onboardingStatusSchema,
		}),
		HttpApiEndpoint.post("complete", "/onboarding/complete", {
			payload: completeOnboardingSchema,
			success: onboardingStatusSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("completeInvite", "/onboarding/complete-invite", {
			payload: completeInviteOnboardingSchema,
			success: completedInviteOnboardingSchema,
		}),
	)
	.middleware(Session) {}
