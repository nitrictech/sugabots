import { Schema } from "effect";
import { uuidSchema } from "./uuid.ts";

export const completeWorkspaceSetupSchema = Schema.Struct({
	workspaceId: uuidSchema,
	botId: uuidSchema,
});
export type CompleteWorkspaceSetup = typeof completeWorkspaceSetupSchema.Type;
