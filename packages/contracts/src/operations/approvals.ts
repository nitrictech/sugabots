/**
 * The approvals operations' contracts, and their entries in the exposure manifest.
 * `index.ts` spreads both, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { toolApprovalDecisionSchema } from "../approvals.ts";
import { ToolApprovalConflict, ToolApprovalNotFound } from "../errors/approvals.ts";
import { ActionForbidden, ResourceHidden } from "../errors/proofs.ts";
import { uuidOrStringSchema } from "../uuid.ts";
import type { DomainExposure } from "./exposure.ts";
import { OperationContract } from "./operation.ts";

export const approvalsContracts = {
	"approvals.decide": OperationContract.make("approvals.decide", {
		description:
			"Allow or deny a tool call waiting for your approval, as its approver: for a request to change a computer, someone who manages its project; for a Personal Assistant's call, its member; for an automation's run, an admin or a manager of its bot; otherwise the member the turn acts for.",
		input: Schema.Struct({ toolCallId: uuidOrStringSchema, ...toolApprovalDecisionSchema.fields }),
		output: Schema.Void,
		errors: [ResourceHidden, ActionForbidden, ToolApprovalNotFound, ToolApprovalConflict],
		changes: true,
	}),
} as const;

export const approvalsExposure = {
	"approvals.decide": {
		http: { kind: "offered", endpoint: "approvals.decide" },
		botLoop: {
			kind: "heldBack",
			reason: "Only a member decides an approval; a bot never decides one, its own or another's.",
		},
	},
} as const satisfies DomainExposure<typeof approvalsContracts>;
