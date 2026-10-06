import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
	completedInviteOnboardingSchema,
	completeInviteOnboardingSchema,
	completeOnboardingSchema,
} from "../../onboarding.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/** The signed-in person finishing setting up a workspace, or joining one by invitation. */
export class OnboardingApi extends HttpApiGroup.make("onboarding")
	.add(
		HttpApiEndpoint.post("complete", "/onboarding/complete", {
			payload: completeOnboardingSchema,
			error: refused,
		}),
		HttpApiEndpoint.post("completeInvite", "/onboarding/complete-invite", {
			payload: completeInviteOnboardingSchema,
			success: completedInviteOnboardingSchema,
		}),
	)
	.middleware(Session) {}
