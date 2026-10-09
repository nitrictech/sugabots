import { Schema } from "effect";
import { uuidSchema } from "./uuid.ts";

export const completeOnboardingSchema = Schema.Struct({
	workspaceId: uuidSchema,
	podId: uuidSchema,
	agentId: uuidSchema,
});
export type CompleteOnboarding = typeof completeOnboardingSchema.Type;

export const completeInviteOnboardingSchema = Schema.Struct({ invitationId: uuidSchema });
export type CompleteInviteOnboarding = typeof completeInviteOnboardingSchema.Type;

export const completedInviteOnboardingSchema = Schema.Struct({ workspaceId: uuidSchema });
export type CompletedInviteOnboarding = typeof completedInviteOnboardingSchema.Type;
