/**
 * The approvals operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { toolApprovalDecisionSchema } from "../approvals.ts";
import { ToolApprovalConflict, ToolApprovalNotFound } from "../errors/approvals.ts";
import { ActionForbidden, ResourceHidden } from "../errors/proofs.ts";
import { uuidOrStringSchema } from "../uuid.ts";
import { OperationContract } from "./operation.ts";

export const approvalsContracts = {
	"approvals.decide": OperationContract.make("approvals.decide", {
		description:
			"Allow or deny a tool call waiting for your approval, as its approver: for a request to change a computer, someone who manages its project; for a personal bot's call, its creator; for an automation's run, an admin or a manager of its bot; otherwise the member the turn acts for.",
		input: Schema.Struct({
			toolCallId: uuidOrStringSchema,
			/**
			 * The approval the member was shown (the call's `approval.id`). A call
			 * asked again, such as after its computer was replaced, has a new one,
			 * so a decision on the request it replaced decides nothing.
			 */
			approvalId: Schema.String,
			...toolApprovalDecisionSchema.fields,
		}),
		output: Schema.Void,
		errors: [ResourceHidden, ActionForbidden, ToolApprovalNotFound, ToolApprovalConflict],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/tool-calls/:toolCallId/approval",
			status: 202,
		},
		botLoop: {
			kind: "heldBack",
			reason: "Only a member decides an approval; a bot never decides one, its own or another's.",
		},
	}),
} as const;
