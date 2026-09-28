import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { ThreadView } from "@sugabots/core/conversations/threads/thread-view";
import { TurnCancellation } from "@sugabots/core/conversations/turns/cancellation";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const threadRoutes = HttpApiBuilder.group(ServerApi, "threads", (handlers) =>
	Effect.gen(function* () {
		const threads = yield* ThreadView.Service;
		const cancellation = yield* TurnCancellation.Service;
		return handlers
			.handle("list", ({ params }) =>
				threads.list(params.workspace).pipe(asSessionUser, asHttpError(threadErrors)),
			)
			.handle("get", ({ params, query, request }) =>
				threads
					.get(params.threadId, request.method === "HEAD" ? { ...query, limit: 1 } : query)
					.pipe(asSessionUser, asHttpError(threadErrors)),
			)
			.handle("activity", ({ params }) =>
				threads.activity(params.threadId).pipe(asSessionUser, asHttpError(threadErrors)),
			)
			.handle("cancelTurn", ({ params }) =>
				Effect.gen(function* () {
					const cancelled = yield* cancellation
						.request(params.turnId)
						.pipe(asSessionUser, asHttpError(threadErrors));
					if (!cancelled) {
						return yield* new NotFound({ message: "No active turn" });
					}
				}),
			);
	}),
);

const threadErrors = {
	...refusals,
	InvalidThreadHistoryCursor: BadRequest,
};
