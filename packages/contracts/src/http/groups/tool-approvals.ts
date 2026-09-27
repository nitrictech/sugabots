import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { toolApprovalDecisionSchema } from "../../tool-approvals.ts";
import { uuidSchema } from "../../uuid.ts";
import { Conflict } from "../errors.ts";
import { Authorise, Session } from "../middleware.ts";

export class ToolApprovalsApi extends HttpApiGroup.make("toolApprovals")
	.add(
		// The decision a caller may make depends on the tool call — a Routine's
		// action asks more than an ordinary approval — so this admits anyone who
		// may decide at all and the store decides the rest. The decision is
		// accepted, then recorded by the turn: the call's status changes on the
		// thread's event stream.
		HttpApiEndpoint.post("decide", "/pods/:podId/tool-calls/:toolCallId/approval", {
			params: { podId: uuidSchema, toolCallId: Schema.String },
			payload: toolApprovalDecisionSchema,
			success: HttpApiSchema.Empty(202),
			error: Conflict,
		}),
	)
	.middleware(Authorise)
	.middleware(Session) {}
