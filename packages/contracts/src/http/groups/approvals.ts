import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { toolApprovalDecisionSchema } from "../../approvals.ts";
import { Conflict, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

export class ApprovalsApi extends HttpApiGroup.make("approvals")
	.add(
		// Who may decide depends on the bot that asked and on the tool call: an
		// automation's action asks more than an ordinary approval. The decision
		// is recorded before this answers, and the call's status changes on the
		// chat's event stream.
		HttpApiEndpoint.post("decide", "/tool-calls/:toolCallId/approval", {
			params: { toolCallId: Schema.String },
			payload: toolApprovalDecisionSchema,
			success: HttpApiSchema.Empty(202),
			error: [Conflict, ...refused],
		}),
	)
	.middleware(Session) {}
