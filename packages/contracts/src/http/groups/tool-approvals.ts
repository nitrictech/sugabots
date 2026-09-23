import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { toolCallPartSchema } from "../../threads.ts";
import { toolApprovalDecisionSchema, toolApprovalRuleSchema } from "../../tool-approvals.ts";
import { uuidSchema } from "../../uuid.ts";
import { Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

export class ToolApprovalsApi extends HttpApiGroup.make("toolApprovals")
	.add(
		// The decision a caller may make depends on the tool call — a Routine's
		// action and an "always allow" ask more than an ordinary approval — so
		// this admits anyone who may decide at all and the store, inside the
		// transaction that settles the call, decides the rest.
		HttpApiEndpoint.post("decide", "/pods/:podId/tool-calls/:toolCallId/approval", {
			params: { podId: uuidSchema, toolCallId: Schema.String },
			payload: toolApprovalDecisionSchema,
			success: toolCallPartSchema,
			error: Conflict,
		}),
		HttpApiEndpoint.get("listRules", "/pods/:podId/tool-approval-rules", {
			params: { podId: uuidSchema },
			success: Schema.Array(toolApprovalRuleSchema),
		}),
		HttpApiEndpoint.delete("revokeRule", "/pods/:podId/tool-approval-rules/:ruleId", {
			params: { podId: uuidSchema, ruleId: Schema.String },
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
