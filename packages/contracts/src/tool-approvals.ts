import { Schema } from "effect";

export const toolApprovalDecisionSchema = Schema.Struct({
	decision: Schema.Literals(["allow_once", "deny"]),
});

export type ToolApprovalDecision = typeof toolApprovalDecisionSchema.Type;
