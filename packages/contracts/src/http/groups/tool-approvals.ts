import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { formAnswerSchema } from "../../forms.ts";
import { toolApprovalDecisionSchema } from "../../tool-approvals.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, refused } from "../errors.ts";
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
	.add(
		// Anyone taking part in the thread may answer a form an agent asked
		// for; the first answer recorded stands, and the turn resumes with it.
		HttpApiEndpoint.post("answerForm", "/pods/:podId/tool-calls/:toolCallId/form-response", {
			params: { podId: uuidSchema, toolCallId: Schema.String },
			// Wrapped: with a bare union as the payload, the derived client types only its first member.
			payload: Schema.Struct({ answer: formAnswerSchema }),
			success: HttpApiSchema.Empty(202),
			error: [BadRequest, Conflict, ...refused],
		}),
	)
	.middleware(Session) {}
