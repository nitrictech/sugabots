import { Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const approvalRoutes = HttpApiBuilder.group(ServerApi, "approvals", (handlers) =>
	Effect.gen(function* () {
		const turns = yield* Turns.Controls;
		return handlers.handle("decide", ({ params, payload }) =>
			turns
				.decide({
					toolCallId: params.toolCallId,
					decision: payload.decision,
				})
				.pipe(asSignedInPerson, asHttpError(approvalErrors)),
		);
	}),
);

const approvalErrors = {
	...refusals,
	ToolApprovalNotFound: NotFound,
	ToolApprovalConflict: Conflict,
	ToolApprovalForbidden: Forbidden,
};
