import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const botRoutes = HttpApiBuilder.group(ServerApi, "bots", (handlers) =>
	Effect.gen(function* () {
		const bots = yield* BotAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				bots.list({ workspace: params.workspace }).pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("create", ({ params, payload }) =>
				bots
					.create({ workspace: params.workspace, bot: payload })
					.pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("get", ({ params }) =>
				bots.get({ botId: params.botId }).pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("update", ({ params, payload }) =>
				bots
					.update({ botId: params.botId, changes: payload })
					.pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("remove", ({ params }) =>
				bots.remove({ botId: params.botId }).pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("pin", ({ params }) =>
				bots
					.setPinned({ botId: params.botId, pinned: true })
					.pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("unpin", ({ params }) =>
				bots
					.setPinned({ botId: params.botId, pinned: false })
					.pipe(asSessionUser, asHttpError(botErrors)),
			)
			.handle("ensureAssistant", ({ params, payload }) =>
				bots
					.ensureAssistant({ workspace: params.workspace, model: payload.model })
					.pipe(asSessionUser, asHttpError(botErrors)),
			);
	}),
);

const botErrors = {
	...refusals,
	ModelNotEnabled: BadRequest,
	EmptyBotUpdate: BadRequest,
	BotNameTaken: Conflict,
	BotHandleReserved: BadRequest,
	BotGone: NotFound,
	SystemBotImmutable: BadRequest,
	AssistantStaysPrivate: BadRequest,
	AssistantInstructionsManaged: BadRequest,
	AssistantManaged: BadRequest,
	ComputerUnavailable: Conflict,
};
