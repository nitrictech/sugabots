import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asCurrentUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

export const botRoutes = HttpApiBuilder.group(ServerApi, "bots", (handlers) =>
	Effect.gen(function* () {
		const bots = yield* BotAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				bots.list({ workspace: params.workspace }).pipe(asCurrentUser, asHttpError(botErrors)),
			)
			.handle("create", ({ params, payload }) =>
				bots
					.create({ workspace: params.workspace, bot: payload })
					.pipe(asCurrentUser, asHttpError(botErrors)),
			)
			.handle("update", ({ params, payload }) =>
				bots
					.update({ botId: params.botId, changes: payload })
					.pipe(asCurrentUser, asHttpError(botErrors)),
			)
			.handle("remove", ({ params }) =>
				bots.remove({ botId: params.botId }).pipe(asCurrentUser, asHttpError(botErrors)),
			)
			.handle("pin", ({ params }) =>
				bots
					.setPinned({ botId: params.botId, pinned: true })
					.pipe(asCurrentUser, asHttpError(botErrors)),
			)
			.handle("unpin", ({ params }) =>
				bots
					.setPinned({ botId: params.botId, pinned: false })
					.pipe(asCurrentUser, asHttpError(botErrors)),
			)
			.handle("ensureAssistant", ({ params, payload }) =>
				bots
					.ensureAssistant({ workspace: params.workspace, model: payload.model })
					.pipe(asCurrentUser, asHttpError(botErrors)),
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
	AssistantVisibilityFixed: BadRequest,
	AssistantInstructionsManaged: BadRequest,
	AssistantManaged: BadRequest,
	ComputerUnavailable: Conflict,
	ComputerMadeMeanwhile: Conflict,
	LeadsProjects: Conflict,
};
