import { sValidator } from "@hono/standard-validator";
import { threadHistoryQuerySchema } from "@sugabots/contracts";
import type {
	InvalidThreadHistoryCursor,
	ThreadStore,
} from "@sugabots/core/conversations/threads/store";
import type { TurnStore } from "@sugabots/core/conversations/turns/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Schema } from "effect";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireWorkspace } from "../../http/authorisation.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface ThreadRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	threads: ThreadStore;
	turns: Pick<TurnStore, "requestCancel">;
}

export function createThreadRoutes({
	resolveSession,
	authorization,
	run,
	threads,
	turns,
}: ThreadRoutesOptions) {
	const session = requireSession(resolveSession);
	const inWorkspace = requireWorkspace(authorization, run, "workspace.read");
	const historyQuery = sValidator(
		"query",
		Schema.toStandardSchemaV1(threadHistoryQuerySchema),
		(result) => {
			if (!result.success) {
				throw new HttpError("bad_request", "That is not a valid history page", result.error);
			}
		},
	);

	return new Hono<AuthEnv>()
		.get("/workspaces/:workspaceId/threads", session, inWorkspace, async (c) =>
			c.json(
				await run(threads.listVisible(c.get("workspace").workspaceId, c.get("session").user.id)),
			),
		)

		.get("/threads/:threadId", session, historyQuery, async (c) => {
			const history = c.req.valid("query");
			const details = await run(
				threads
					.getVisible(
						c.req.param("threadId"),
						c.get("session").user.id,
						c.req.method === "HEAD" ? { ...history, limit: 1 } : history,
					)
					.pipe(asHttpError(threadErrors)),
			);
			if (!details) {
				throw new HttpError("not_found", "No such thread");
			}
			return c.json(details);
		})
		.post("/turns/:turnId/cancel", session, async (c) => {
			const cancelled = await run(
				turns.requestCancel(c.req.param("turnId"), c.get("session").user.id),
			);
			if (!cancelled) {
				throw new HttpError("not_found", "No active turn");
			}
			return c.body(null, 202);
		});
}

const threadErrors = {
	InvalidThreadHistoryCursor: (failure: InvalidThreadHistoryCursor) =>
		new HttpError("bad_request", failure.message),
};
