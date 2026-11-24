import { Conflict, NotFound } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** Deciding a tool call a turn waits on, as its operation. */
export const approvalRoutes = HttpApiBuilder.group(ServerApi, "approvals", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers.handle("decide", ({ params, payload }) =>
			callOperation("approvals.decide", {
				toolCallId: params.toolCallId,
				decision: payload.decision,
			}).pipe(asHttpError(approvalErrors)),
		),
	),
);

/** What each way deciding can fail means over HTTP. */
const approvalErrors = {
	...refusals,
	ToolApprovalNotFound: NotFound,
	ToolApprovalConflict: Conflict,
};
