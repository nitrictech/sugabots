import { Schema } from "effect";
import { uuidSchema } from "./uuid.ts";

export const completeOnboardingSchema = Schema.Struct({
	workspaceId: uuidSchema,
	agentId: uuidSchema,
});
export type CompleteOnboarding = typeof completeOnboardingSchema.Type;
