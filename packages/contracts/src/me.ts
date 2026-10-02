import { Schema } from "effect";
import { sessionUserSchema } from "./api.ts";
import { workspaceSchema } from "./membership.ts";
import { onboardingStatusSchema } from "./onboarding.ts";

/**
 * Who the caller is, whether they have finished setting up, and their
 * workspaces: what the web app needs before it can draw anything, in one
 * answer rather than three requests, the second and third of which would wait
 * for the first to say they are signed in.
 */
export const meSchema = Schema.Struct({
	user: sessionUserSchema,
	onboarding: onboardingStatusSchema,
	workspaces: Schema.Array(workspaceSchema),
});

export type Me = typeof meSchema.Type;
