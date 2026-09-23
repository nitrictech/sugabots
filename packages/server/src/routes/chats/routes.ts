import { sValidator } from "@hono/standard-validator";
import { chatPageQuerySchema, getOrCreateChatSchema, newMessageSchema } from "@sugabots/contracts";
import type {
	ChatAgentHasNoModel,
	ChatMessageIdConflict,
	ChatPlacementRejected,
	ChatStore,
	InvalidChatCursor,
} from "@sugabots/core/conversations/chats/store";
import type { Authorization } from "@sugabots/core/workspaces/access";
import { Schema } from "effect";
import { Hono } from "hono";
import { type AuthEnv, requireSession } from "../../auth/middleware.ts";
import type { SessionResolver } from "../../auth/session.ts";
import { requireWorkspace } from "../../http/authorisation.ts";
import { body } from "../../http/body.ts";
import { asHttpError, HttpError } from "../../http/errors.ts";
import type { RunHandler } from "../../http/handler.ts";

export interface ChatRoutesOptions {
	resolveSession: SessionResolver;
	authorization: Authorization;
	run: RunHandler;
	chats: ChatStore;
}

export function createChatRoutes({ resolveSession, authorization, run, chats }: ChatRoutesOptions) {
	const session = requireSession(resolveSession);
	const inWorkspace = requireWorkspace(authorization, run, "workspace.read");
	const page = sValidator("query", Schema.toStandardSchemaV1(chatPageQuerySchema), (result) => {
		if (!result.success)
			throw new HttpError("bad_request", "That is not a valid chat page", result.error);
	});

	return new Hono<AuthEnv>()
		.post(
			"/workspaces/:workspaceId/chats",
			session,
			inWorkspace,
			body(getOrCreateChatSchema),
			async (c) =>
				c.json(
					await run(
						chats
							.getOrCreate({
								...c.req.valid("json"),
								workspaceId: c.get("workspace").workspaceId,
								userId: c.get("session").user.id,
							})
							.pipe(asHttpError(chatErrors)),
					),
				),
		)
		.get("/chats/:chatId/messages", session, page, async (c) => {
			const result = await run(
				chats
					.messages(c.req.param("chatId"), c.get("session").user.id, c.req.valid("query"))
					.pipe(asHttpError(chatErrors)),
			);
			if (!result) throw new HttpError("not_found", "No such chat");
			return c.json(result);
		})
		.get("/chats/:chatId/history", session, page, async (c) => {
			const result = await run(
				chats
					.history(c.req.param("chatId"), c.get("session").user.id, c.req.valid("query"))
					.pipe(asHttpError(chatErrors)),
			);
			if (!result) throw new HttpError("not_found", "No such chat");
			return c.json(result);
		})
		.post("/chats/:chatId/messages", session, body(newMessageSchema), async (c) => {
			const input = c.req.valid("json");
			const result = await run(
				chats
					.sendMain({
						chatId: c.req.param("chatId"),
						userId: c.get("session").user.id,
						messageId: input.id,
						content: input.message,
					})
					.pipe(asHttpError(chatErrors)),
			);
			if (!result) throw new HttpError("not_found", "No such chat");
			return c.json(result, 201);
		});
}

const chatErrors = {
	ChatPlacementRejected: (failure: ChatPlacementRejected) =>
		new HttpError("bad_request", failure.message),
	ChatMessageIdConflict: (failure: ChatMessageIdConflict) =>
		new HttpError("conflict", failure.message),
	ChatAgentHasNoModel: (failure: ChatAgentHasNoModel) => new HttpError("conflict", failure.message),
	InvalidChatCursor: (failure: InvalidChatCursor) => new HttpError("bad_request", failure.message),
};
