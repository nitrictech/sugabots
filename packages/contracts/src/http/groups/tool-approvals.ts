import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { toolApprovalDecisionSchema } from "../../tool-approvals.ts";
import { uuidSchema } from "../../uuid.ts";
import { Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class ToolApprovalsApi extends HttpApiGroup.make("toolApprovals")
	.add(
		// Who may decide depends on the tool call as well as the pod: a Routine's
		// action asks more than an ordinary approval. The decision is recorded
		// before this answers, and the call's status changes on the thread's
		// event stream.
		HttpApiEndpoint.post("decide", "/pods/:podId/tool-calls/:toolCallId/approval", {
			params: { podId: uuidSchema, toolCallId: Schema.String },
			payload: toolApprovalDecisionSchema,
			success: HttpApiSchema.Empty(202),
			error: [Conflict, ...refused],
		}),
	)
	.middleware(Session) {}
