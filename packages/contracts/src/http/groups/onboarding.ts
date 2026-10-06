import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { completeOnboardingSchema } from "../../onboarding.ts";
import { refused } from "../errors.ts";
import { Session } from "../middleware.ts";

/** The signed-in person finishing setting up a workspace. */
export class OnboardingApi extends HttpApiGroup.make("onboarding")
	.add(
		HttpApiEndpoint.post("complete", "/onboarding/complete", {
			payload: completeOnboardingSchema,
			error: refused,
		}),
	)
	.middleware(Session) {}
