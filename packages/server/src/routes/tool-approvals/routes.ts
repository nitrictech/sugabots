import { Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { Turns } from "@sugabots/core/conversations/turns/turns";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const toolApprovalRoutes = HttpApiBuilder.group(ServerApi, "toolApprovals", (handlers) =>
	Effect.gen(function* () {
		const turns = yield* Turns.Controls;
		return handlers.handle("decide", ({ params, payload }) =>
			turns
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
