import { Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { ToolApprovals } from "@sugabots/core/conversations/turns/approvals/tool-approvals";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const toolApprovalRoutes = HttpApiBuilder.group(ServerApi, "toolApprovals", (handlers) =>
	Effect.gen(function* () {
		const approvals = yield* ToolApprovals.Service;
		return handlers.handle("decide", ({ params, payload }) =>
			approvals
				.decide({
					podId: params.podId,
					toolCallId: params.toolCallId,
					decision: payload.decision,
				})
				.pipe(asSessionUser, asHttpError(approvalErrors)),
		);
	}),
);

const approvalErrors = {
	...refusals,
	ToolApprovalNotFound: NotFound,
	ToolApprovalConflict: Conflict,
	ToolApprovalForbidden: Forbidden,
};
