import { Schema } from "effect";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

export const toolApprovalDecisionSchema = Schema.Struct({
	decision: Schema.Literals(["allow_once", "deny", "always_allow"]),
});

export type ToolApprovalDecision = typeof toolApprovalDecisionSchema.Type;

export const toolApprovalRuleSchema = Schema.Struct({
	id: uuidSchema,
	agentId: uuidSchema,
	agentName: Schema.String,
	connectionId: uuidSchema,
	connectionName: Schema.String,
	toolName: Schema.String,
	createdAt: isoTimestampSchema,
});

export type ToolApprovalRule = typeof toolApprovalRuleSchema.Type;
