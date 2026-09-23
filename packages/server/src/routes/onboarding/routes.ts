import { completeInviteOnboardingSchema, completeOnboardingSchema } from "@sugabots/contracts";
import type { OnboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { body } from "../../http/body.ts";
import { HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

/** Whether the signed-in person has finished setting up, and marking that they have. */
export interface OnboardingRoutesOptions {
	resolveSession: SessionResolver;
	run: RunHandler;
	onboarding: OnboardingStore;
}

export function createOnboardingRoutes({
	resolveSession,
	run,
	onboarding,
}: OnboardingRoutesOptions) {
	const session = requireSession(resolveSession);

	return new Hono<AuthEnv>()
		.get("/onboarding", session, async (c) =>
			c.json({ completed: await run(onboarding.isCompleted(c.get("session").user.id)) }),
		)
		.post("/onboarding/complete", session, body(completeOnboardingSchema), async (c) => {
			const { workspaceId, podId, agentId } = c.req.valid("json");
			const completed = await run(
				onboarding.complete(c.get("session").user.id, workspaceId, podId, agentId),
			);
			if (!completed) {
				throw new HttpError("bad_request", "Finish creating your pod and agent first");
			}
			return c.json({ completed: true as const });
		})
		.post(
			"/onboarding/complete-invite",
			session,
			body(completeInviteOnboardingSchema),
			async (c) => {
				const { invitationId } = c.req.valid("json");
				const workspaceId = await run(
					onboarding.completeAcceptedInvite(c.get("session").user.id, invitationId),
				);
				if (!workspaceId) {
					throw new HttpError(
						"bad_request",
						"The invitation has not been accepted by this account",
					);
				}
				return c.json({ workspaceId });
			},
		);
}
