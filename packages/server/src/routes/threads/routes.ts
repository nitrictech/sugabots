import { BadRequest, CurrentUser, NotFound } from "@sugabots/contracts/http";
import type { ThreadStore } from "@sugabots/core/conversations/threads/store";
import type { TurnStore } from "@sugabots/core/conversations/turns/store";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { grantedWorkspace } from "../../http/authorisation.ts";
import { asHttpError } from "../../http/errors.ts";

export interface ThreadRoutesOptions {
	threads: ThreadStore;
	turns: Pick<TurnStore, "requestCancel">;
}

export function threadRoutes({ threads, turns }: ThreadRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "threads", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.flatMap(grantedWorkspace, ({ workspaceId, actor }) =>
					threads.listVisible(workspaceId, actor.userId),
				),
			)
			.handle("get", ({ params, query, request }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const details = yield* threads
						.getVisible(
							params.threadId,
							user.id,
							request.method === "HEAD" ? { ...query, limit: 1 } : query,
						)
						.pipe(asHttpError(threadErrors));
					return details ?? (yield* new NotFound({ message: "No such thread" }));
				}),
			)
			.handle("activity", ({ params }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const activity = yield* threads.activity(params.threadId, user.id);
					return activity ?? (yield* new NotFound({ message: "No such thread" }));
				}),
			)
			.handle("cancelTurn", ({ params }) =>
				Effect.gen(function* () {
					const user = yield* CurrentUser;
					const cancelled = yield* turns.requestCancel(params.turnId, user.id);
					if (!cancelled) {
						return yield* new NotFound({ message: "No active turn" });
					}
				}),
			),
	);
}

const threadErrors = {
	InvalidThreadHistoryCursor: BadRequest,
};
