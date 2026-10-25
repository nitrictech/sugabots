import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { Reactions } from "@sugabots/core/conversations/reactions/reactions";
import { ThreadView } from "@sugabots/core/conversations/thread-view";
import { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import { Turns } from "@sugabots/core/conversations/turns/turns";
import { userText } from "@sugabots/errors";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const threadRoutes = HttpApiBuilder.group(ServerApi, "threads", (handlers) =>
	Effect.gen(function* () {
		const threads = yield* ThreadView.Service;
		const turns = yield* Turns.Controls;
		const reactions = yield* Reactions.Service;
		const desktops = yield* DesktopViewer.Service;
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
			.handle("desktopUnreachedSites", ({ params }) =>
				desktops
					.unreachedSites(params)
					.pipe(asSessionUser, asHttpError({ ...threadErrors, ...desktopErrors })),
			)
			.handle("reloadDesktopUnreachedSites", ({ params, payload }) =>
				desktops
					.reloadUnreachedSites({ ...params, hosts: payload.hosts })
					.pipe(asSessionUser, asHttpError({ ...threadErrors, ...desktopErrors })),
			)
			.handle("react", ({ params }) =>
				reactions
					.add(params.messageId, params.emoji)
					.pipe(asSessionUser, asHttpError(threadErrors)),
			)
			.handle("unreact", ({ params }) =>
				reactions
					.remove(params.messageId, params.emoji)
					.pipe(asSessionUser, asHttpError(threadErrors)),
			)
			.handle("cancelTurn", ({ params }) =>
				Effect.gen(function* () {
					const cancelled = yield* turns
						.cancel(params.turnId)
						.pipe(asSessionUser, asHttpError(threadErrors));
					if (!cancelled) {
						return yield* new NotFound({ message: userText`No active turn` });
					}
				}),
			);
	}),
);

const desktopErrors = { DesktopUnavailable: NotFound, SandboxUnavailable: Conflict };

const threadErrors = {
	...refusals,
	InvalidThreadHistoryCursor: BadRequest,
	MessageNotFinished: Conflict,
	TooManyReactionEmoji: Conflict,
};
