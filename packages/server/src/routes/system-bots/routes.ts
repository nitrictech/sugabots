import { systemBotKeySchema } from "@sugabots/contracts";
import { BadRequest, NotFound } from "@sugabots/contracts/http";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { userText } from "@sugabots/errors";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/**
 * The workspace's system bots, addressed by key. `SystemBotsApi` says why
 * reading them is open to the whole workspace.
 */
export const systemBotRoutes = HttpApiBuilder.group(ServerApi, "systemBots", (handlers) =>
	Effect.gen(function* () {
		const bots = yield* BotAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				bots
					.systemBots({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(systemBotErrors)),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					const key = Schema.decodeUnknownOption(systemBotKeySchema)(params.key);
					if (key._tag === "None") {
						return yield* new NotFound({ message: userText`No such built-in bot` });
					}
					return yield* bots
						.setSystemBotModel({
							workspace: params.workspace,
							key: key.value,
							model: payload.model,
						})
						.pipe(asSessionUser, asHttpError(systemBotErrors));
				}),
			);
	}),
);

const systemBotErrors = {
	...refusals,
	ModelNotEnabled: BadRequest,
	SystemBotMissing: NotFound,
};
